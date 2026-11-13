import crypto from 'node:crypto';
import { HttpError } from './errors.js';

const cache = new Map();
const CACHE_TTL = 6 * 60 * 60 * 1000;
function dashedUuid(hex) {
  const s = hex.replaceAll('-', '').toLowerCase();
  return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`;
}
function offlineUuid(username) {
  const hash = crypto.createHash('md5').update(`OfflinePlayer:${username}`, 'utf8').digest();
  hash[6] = (hash[6] & 0x0f) | 0x30;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  return dashedUuid(hash.toString('hex'));
}
async function fetchJson(url) {
  const response = await fetch(url, { headers: { 'User-Agent': 'MC-Pulse/1.0 (+Minecraft server status API)' }, signal: AbortSignal.timeout(7000) });
  if (response.status === 404) throw new HttpError(404, 'PLAYER_NOT_FOUND', 'Minecraft player was not found.');
  if (!response.ok) throw new HttpError(502, 'MOJANG_UNAVAILABLE', 'The official Minecraft profile service is unavailable.');
  return response.json();
}

export async function getPlayerProfile(query) {
  const key = query.toLowerCase();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  let uuid = query.replaceAll('-', '').toLowerCase();
  let username = query;
  if (!/^[0-9a-f]{32}$/i.test(uuid)) {
    const basic = await fetchJson(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(query)}`);
    uuid = basic.id;
    username = basic.name;
  }
  const session = await fetchJson(`https://sessionserver.mojang.com/session/minecraft/profile/${uuid}`);
  const textureProperty = (session.properties || []).find(p => p.name === 'textures');
  let textures = null;
  if (textureProperty?.value) {
    try { textures = JSON.parse(Buffer.from(textureProperty.value, 'base64').toString('utf8')); } catch { /* Ignore malformed optional texture metadata. */ }
  }
  const resolvedName = session.name || username;
  const result = {
    username: resolvedName,
    uuid: dashedUuid(uuid),
    uuidDashed: dashedUuid(uuid),
    uuidUndashed: uuid,
    offlineUuid: offlineUuid(resolvedName),
    intArrayUuid: `[I; ${[0,1,2,3].map(i => (parseInt(uuid.slice(i * 8, i * 8 + 8), 16) | 0)).join(', ')}]`,
    skinUrl: textures?.textures?.SKIN?.url || null,
    skinModel: textures?.textures?.SKIN?.metadata?.model || 'classic',
    capeUrl: textures?.textures?.CAPE?.url || null,
    mojangCapeUrl: textures?.textures?.CAPE?.url || null,
    textureHash: textures?.textures?.SKIN?.url?.split('/').pop() || 'default-steve',
    textureTimestamp: textures?.timestamp ? new Date(textures.timestamp).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : 'Available in Raw JSON',
    signaturePresent: Boolean(textureProperty?.signature),
    textures,
    decodedTextures: textures
  };
  cache.set(key, { value: result, expiresAt: Date.now() + CACHE_TTL });
  return result;
}
