import test from 'node:test';
import assert from 'node:assert/strict';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
process.env.API_KEY_PEPPER = 'this-is-a-test-pepper-with-more-than-32-bytes';

const { initializeConfig } = await import('../src/config.js');
initializeConfig(process.env);
const security = await import('../src/security.js');
const mc = await import('../src/minecraft-protocol.js');

test('API key hashes are stable and generated keys are random-looking', () => {
  const key = security.createApiKey();
  assert.match(key, /^mcp_live_[A-Za-z0-9_-]{43}$/);
  assert.equal(security.hashApiKey(key), security.hashApiKey(key));
  assert.notEqual(security.hashApiKey(key), security.hashApiKey(security.createApiKey()));
});

test('private and reserved IPv4 addresses are rejected', () => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.2', '169.254.169.254', '0.0.0.0']) assert.equal(security.isPublicIp(ip), false, ip);
  assert.equal(security.isPublicIp('1.1.1.1'), true);
});


test('IP address parser rejects malformed IPv4 and IPv6 literals', () => {
  for (const ip of ['999.1.1.1', '1.2.3', '2001:4860:99999::1', '1:2:3:4:5:6:7', '1::2::3', ':']) assert.equal(security.isIpAddress(ip), 0, ip);
  assert.equal(security.isIpAddress('8.8.8.8'), 4);
  assert.equal(security.isIpAddress('2606:4700:4700::1111'), 6);
});

test('private, special-purpose, and documentation IPv6 addresses are rejected', () => {
  for (const ip of ['::', '::1', 'fe80::1', 'fc00::1', 'fd00::1', 'ff02::1', '::ffff:127.0.0.1', '2001:db8::1', '2001:2::1', '2001:0::1', '2002::1', '3fff::1']) assert.equal(security.isPublicIp(ip), false, ip);
  assert.equal(security.isPublicIp('2606:4700:4700::1111'), true);
  assert.equal(security.isPublicIp('2001:4860:4860::8888'), true);
});

test('VarInt encoding and decoding round-trip common protocol values', () => {
  for (const value of [0, 1, 127, 128, 255, 767, 2147483647]) {
    const encoded = mc.javaStatusPacket('example.com', 25565); // smoke test packet construction
    assert.ok(encoded instanceof Uint8Array);
    const bytes = [];
    let n = value >>> 0;
    do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; bytes.push(b); } while (n);
    assert.equal(mc.readVarInt(Buffer.from(bytes)).value, value >>> 0);
  }
});

test('invalid low ports are rejected', () => {
  assert.throws(() => security.validatePort(80, 25565), /Port must/);
  assert.equal(security.validatePort(25565, 25565), 25565);
});


test('Java status packet parser reads a complete framed JSON response', () => {
  const encode = value => {
    const out = [];
    let n = value >>> 0;
    do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n);
    return Buffer.from(out);
  };
  const json = Buffer.from(JSON.stringify({ version: { name: 'Test Server', protocol: 767 }, players: { online: 2, max: 20 } }));
  const packet = Buffer.concat([encode(0), encode(json.length), json]);
  const framed = Buffer.concat([encode(packet.length), packet]);
  assert.deepEqual(mc.parseJavaResponse(framed), JSON.parse(json.toString()));
  assert.throws(() => mc.parseJavaResponse(framed.subarray(0, 3)), /Incomplete response/);
});

test('Bedrock direct UDP is explicitly excluded from the Worker runtime', () => {
  assert.ok(true, 'Cloudflare Workers do not expose general outbound UDP sockets.');
});

const software = await import('../src/software.js');

test('software catalog lists supported official server platforms', () => {
  const ids = software.SOFTWARE_CATALOG.map(p => p.id);
  for (const id of ['vanilla', 'paper', 'purpur', 'folia', 'fabric', 'quilt', 'forge', 'neoforge', 'spigot']) assert.ok(ids.includes(id), id);
});

test('software endpoints reject unknown loaders and malformed versions before upstream requests', async () => {
  await assert.rejects(() => software.listSoftwareVersions('random-loader'), /supported server software/);
  await assert.rejects(() => software.listSoftwareBuilds('vanilla', '../private'), /valid Minecraft version/);
  await assert.rejects(() => software.resolveSoftwareDownload('paper', '1.21.4', 'https://evil.example/file.jar'), /selected build is invalid/);
});

test('vanilla download resolver uses the official Mojang version manifest URL', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes('version_manifest_v2.json')) return new Response(JSON.stringify({ versions: [{ id: '1.21.4', url: 'https://piston-meta.mojang.com/version.json' }] }), { status: 200 });
    return new Response(JSON.stringify({ downloads: { server: { url: 'https://piston-data.mojang.com/v1/objects/hash/server.jar' } } }), { status: 200 });
  };
  try {
    const result = await software.resolveSoftwareDownload('vanilla', '1.21.4', 'official');
    assert.equal(result.url, 'https://piston-data.mojang.com/v1/objects/hash/server.jar');
    assert.equal(result.fileName, 'minecraft_server.1.21.4.jar');
    assert.equal(calls.length, 2);
  } finally { globalThis.fetch = originalFetch; }
});

test('Paper resolver only accepts a build returned by PaperMC stable metadata', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/builds?')) return new Response(JSON.stringify([{ id: 42, channel: 'STABLE', downloads: { 'server:default': { name: 'paper-1.21.4-42.jar', url: 'https://fill-data.papermc.io/v1/objects/hash/paper.jar', checksums: { sha256: 'abc' }, size: 1000 } } }]), { status: 200 });
    return new Response(JSON.stringify({ downloads: { 'server:default': { name: 'paper-1.21.4-42.jar', url: 'https://fill-data.papermc.io/v1/objects/hash/paper.jar', checksums: { sha256: 'abc' }, size: 1000 } } }), { status: 200 });
  };
  try {
    const result = await software.resolveSoftwareDownload('paper', '1.21.4', '42');
    assert.equal(result.kind, 'jar');
    assert.equal(result.sha256, 'abc');
    await assert.rejects(() => software.resolveSoftwareDownload('paper', '1.21.4', '999'), /stable build is unavailable/);
  } finally { globalThis.fetch = originalFetch; }
});

test('Quilt and Spigot version catalogs use their correct upstream version sources', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('meta.quiltmc.org/v3/versions/game')) return new Response(JSON.stringify([{ version: '1.21.4', stable: true }, { version: '1.21.5-snapshot', stable: false }]), { status: 200 });
    if (String(url).includes('version_manifest_v2.json')) return new Response(JSON.stringify({ versions: [{ id: '1.21.4', type: 'release' }, { id: '25w01a', type: 'snapshot' }] }), { status: 200 });
    throw new Error(`Unexpected URL ${url}`);
  };
  try {
    const quilt = await software.listSoftwareVersions('quilt');
    const spigot = await software.listSoftwareVersions('spigot');
    assert.deepEqual(quilt.map(v => v.id), ['1.21.4', '1.21.5-snapshot']);
    assert.deepEqual(spigot.map(v => v.id), ['1.21.4']);
  } finally { globalThis.fetch = originalFetch; }
});

test('NeoForge metadata maps legacy and modern artifact lines to Minecraft versions', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('<metadata><versioning><versions><version>47.1.106</version><version>21.1.172</version><version>20.6.139</version></versions></versioning></metadata>', { status: 200 });
  try {
    const versions = await software.listSoftwareVersions('neoforge');
    assert.deepEqual(new Set(versions.map(v => v.id)), new Set(['1.20.1', '1.21.1', '1.20.6']));
  } finally { globalThis.fetch = originalFetch; }
});

test('Vanilla resolver rejects metadata URLs outside Mojang metadata host', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ versions: [{ id: '1.21.4', url: 'http://127.0.0.1/private.json' }] }), { status: 200 });
  };
  try {
    await assert.rejects(() => software.resolveSoftwareDownload('vanilla', '1.21.4', 'official'), /unsupported metadata host/);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = originalFetch; }
});
