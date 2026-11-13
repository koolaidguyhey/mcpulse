import crypto from 'node:crypto';
import { config } from './config.js';
import { HttpError } from './errors.js';

export function isIpAddress(value) {
  if (typeof value !== 'string') return 0;
  const ip = value.replace(/^\[|\]$/g, '');
  const parts = ip.split('.');
  if (parts.length === 4 && parts.every(x => /^\d{1,3}$/.test(x) && Number(x) <= 255)) return 4;
  if (!ip.includes(':') || ip.includes('.') || !/^[0-9a-f:]+$/i.test(ip)) return 0;
  const halves = ip.split('::');
  if (halves.length > 2) return 0;
  const groups = ip.split(':').filter(Boolean);
  if (groups.some(group => group.length > 4) || groups.length > 8) return 0;
  if (halves.length === 1 && groups.length !== 8) return 0;
  if (halves.length === 2 && groups.length >= 8) return 0;
  return 6;
}

export function createApiKey() {
  return `mcp_live_${crypto.randomBytes(32).toString('base64url')}`;
}

export function hashApiKey(key) {
  return crypto.createHmac('sha256', config.apiKeyPepper).update(key).digest('hex');
}


function ipv4Number(ip) {
  return ip.split('.').reduce((n, part) => ((n << 8) | Number(part)) >>> 0, 0);
}
function inV4(ip, base, bits) {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4Number(ip) & mask) === (ipv4Number(base) & mask);
}

export function isPublicIp(ip) {
  const family = isIpAddress(ip);
  if (family === 4) {
    const blocked = [
      ['192.88.99.0', 24],
      ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
      ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
      ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
      ['224.0.0.0', 4], ['240.0.0.0', 4]
    ];
    return !blocked.some(([base, bits]) => inV4(ip, base, bits));
  }
  if (family === 6) {
    const lower = ip.toLowerCase();
    if (lower.startsWith('::ffff:')) {
      const mapped = lower.slice(7);
      if (isIpAddress(mapped) === 4) return isPublicIp(mapped);
      return false;
    }
    // Only global-unicast 2000::/3 is eligible. Exclude IANA special-purpose
    // ranges inside that block, including protocol assignments and documentation.
    if (!lower.startsWith('2') && !lower.startsWith('3')) return false;
    const first = parseInt(lower.split(':')[0] || '0', 16);
    const second = parseInt((lower.split(':')[1] || '0'), 16);
    if (first < 0x2000 || first > 0x3fff) return false;
    if (first === 0x2001 && second <= 0x01ff) return false; // 2001::/23 special-purpose
    if (first === 0x2001 && second === 0x0db8) return false; // Documentation
    if (first === 0x2002) return false; // 6to4
    if (first === 0x3fff && second <= 0x0fff) return false; // Documentation (3fff::/20)
    return true;
  }
  return false;
}

export async function resolvePublicHost(host) {
  if (typeof host !== 'string' || host.length > 253 || !host.trim()) throw new HttpError(400, 'INVALID_HOST', 'A valid hostname is required.');
  const normalized = host.trim().replace(/^\[|\]$/g, '').toLowerCase();
  if (normalized === 'localhost' || normalized.endsWith('.localhost') || normalized.endsWith('.local') || normalized.endsWith('.internal')) {
    throw new HttpError(400, 'BLOCKED_HOST', 'Local and private network destinations are not allowed.');
  }
  let records;
  if (isIpAddress(normalized)) records = [{ address: normalized, family: isIpAddress(normalized) }];
  else {
    if (!/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(normalized) || normalized.includes('..')) {
      throw new HttpError(400, 'INVALID_HOST', 'Hostname format is invalid.');
    }
    try {
      const answers = await Promise.all(['A', 'AAAA'].map(async type => {
        const response = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(normalized)}&type=${type}`, { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(4000) });
        if (!response.ok) return [];
        const data = await response.json();
        return (data.Answer || []).filter(x => x.type === (type === 'A' ? 1 : 28)).map(x => ({ address: x.data, family: type === 'A' ? 4 : 6 }));
      }));
      records = answers.flat();
    } catch { throw new HttpError(400, 'DNS_FAILED', 'The hostname could not be resolved.'); }
  }
  if (!records.length || records.some(record => !isPublicIp(record.address))) {
    throw new HttpError(400, 'BLOCKED_HOST', 'The hostname resolves to a private or reserved address.');
  }
  return { hostname: normalized, address: records[0].address, family: records[0].family };
}

export function validatePort(value, fallback) {
  const port = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new HttpError(400, 'INVALID_PORT', 'Port must be an integer from 1024 to 65535.');
  }
  return port;
}

export function validatePlayerQuery(value) {
  if (typeof value !== 'string') throw new HttpError(400, 'INVALID_PLAYER', 'A Minecraft username or UUID is required.');
  const q = value.trim();
  const uuid = /^[0-9a-f]{32}$/i.test(q.replaceAll('-', ''));
  if (!uuid && !/^[A-Za-z0-9_]{1,16}$/.test(q)) throw new HttpError(400, 'INVALID_PLAYER', 'Enter a valid Minecraft username or UUID.');
  return q;
}
