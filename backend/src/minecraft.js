import { connect } from 'cloudflare:sockets';
import { config } from './config.js';
import { HttpError } from './errors.js';
import { resolvePublicHost, validatePort, isIpAddress } from './security.js';

import { javaStatusPacket, parseJavaResponse } from './minecraft-protocol.js';

function concat(parts, total = parts.reduce((n, part) => n + part.length, 0)) {
  const output = new Uint8Array(total); let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.length; }
  return output;
}
function withTimeout(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); })]).finally(() => clearTimeout(timer));
}

async function resolveSrv(hostname) {
  const service = `_minecraft._tcp.${hostname}`;
  try {
    const response = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(service)}&type=SRV`, { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(3000) });
    if (!response.ok) return null;
    const data = await response.json();
    const rows = (data.Answer || []).filter(x => x.type === 33).map(x => {
      const m = String(x.data).trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
      return m ? { priority: Number(m[1]), weight: Number(m[2]), port: Number(m[3]), name: m[4].replace(/\.$/, '') } : null;
    }).filter(Boolean).sort((a,b) => a.priority-b.priority || b.weight-a.weight);
    return rows[0] || null;
  } catch { return null; }
}
export async function resolveMinecraftTarget(host, portValue, edition = 'java') {
  const original = await resolvePublicHost(host);
  const explicit = portValue !== undefined && portValue !== null && portValue !== '';
  if (explicit || isIpAddress(original.hostname)) return { ...original, port: validatePort(portValue, edition === 'bedrock' ? 19132 : 25565), srvRecord: null };
  const srv = await resolveSrv(original.hostname);
  if (srv && Number.isInteger(srv.port) && srv.port >= 1024 && srv.port <= 65535 && srv.name !== '.') {
    try { const target = await resolvePublicHost(srv.name); return { hostname: original.hostname, address: target.address, family: target.family, port: srv.port, srvRecord: `${target.hostname}:${srv.port}` }; } catch { /* use original host */ }
  }
  return { ...original, port: 25565, srvRecord: null };
}

export async function pingJava(host, portValue) {
  const target = await resolveMinecraftTarget(host, portValue, 'java');
  const started = Date.now();
  let socket;
  try {
    socket = connect({ hostname: target.address, port: target.port });
    await withTimeout(socket.opened, config.requestTimeoutMs);
    const writer = socket.writable.getWriter();
    await writer.write(javaStatusPacket(target.hostname, target.port));
    writer.releaseLock();
    const reader = socket.readable.getReader();
    const chunks = []; let total = 0;
    while (total <= 65536) {
      const next = await withTimeout(reader.read(), config.requestTimeoutMs);
      if (next.done) throw new HttpError(502, 'INCOMPLETE_RESPONSE', 'Minecraft server closed the connection before completing its status response.');
      chunks.push(next.value); total += next.value.length;
      if (total > 65536) throw new HttpError(502, 'BAD_RESPONSE', 'Minecraft server response was too large.');
      try {
        const parsed = parseJavaResponse(concat(chunks, total));
        await reader.cancel().catch(() => {});
        return { online: true, edition: 'java', host: target.hostname, port: target.port, resolvedIp: target.address, srvRecord: target.srvRecord, latencyMs: Date.now() - started, version: parsed.version || null, players: parsed.players || null, description: parsed.description || null, favicon: parsed.favicon || null, iconSourceNote: parsed.favicon ? 'Live Java SLP Favicon' : 'No Server Icon Set', software: parsed.version?.name || 'Java Server', mods: [], plugins: [], eulaBlocked: false, enforcesSecureChat: parsed.enforcesSecureChat ?? null, rawStatus: parsed, raw: parsed };
      } catch (error) { if (error.code !== 'INCOMPLETE_PACKET') throw new HttpError(502, 'BAD_RESPONSE', 'Minecraft server returned an invalid Java status response.'); }
    }
    throw new HttpError(502, 'BAD_RESPONSE', 'Minecraft server response was too large.');
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (String(error?.message).toLowerCase().includes('timeout')) throw new HttpError(504, 'TIMEOUT', 'Minecraft Java status request timed out.');
    throw new HttpError(502, 'CONNECTION_FAILED', 'Could not connect to the Minecraft Java server from Cloudflare Workers.');
  } finally { try { socket?.close(); } catch {} }
}

export async function pingBedrock() {
  throw new HttpError(501, 'BEDROCK_UDP_UNAVAILABLE', 'Direct Bedrock RakNet UDP checks are not supported by Cloudflare Workers. Java Edition checks are available.');
}
export const minecraftInternals = { parseJavaResponse, javaStatusPacket };
