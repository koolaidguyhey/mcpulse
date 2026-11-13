import { config } from './config.js';
import { HttpError } from './errors.js';
import { hashApiKey, validatePlayerQuery, isIpAddress } from './security.js';
import { pingJava, pingBedrock, resolveMinecraftTarget } from './minecraft.js';
import { findApiKey, recordUsage, recordServerCheck, getServerHistory, getDailyServerHistory, runMaintenance } from './database.js';
import { SOFTWARE_CATALOG, listSoftwareVersions, listSoftwareBuilds, resolveSoftwareDownload } from './software.js';

const authCache = new Map();
const rateBuckets = new Map();
const AUTH_CACHE_TTL_MS = 5000;
const MAX_RATE_BUCKETS = 10000;
let inFlight = 0;
let lastRatePruneAt = 0;
const MAX_IN_FLIGHT = 20;

function json(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()', ...extraHeaders });
  res.end(payload);
}

function svgEscape(value) {
  return String(value).replace(/[&<>\"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', "'": '&apos;' })[ch]);
}
function statusBadgeSvg(label, value, online, style = 'flat') {
  const left = svgEscape(label.slice(0, 36));
  const right = svgEscape(value.slice(0, 42));
  const leftWidth = Math.max(64, Math.min(190, left.length * 7 + 18));
  const rightWidth = Math.max(72, Math.min(230, right.length * 7 + 18));
  const total = leftWidth + rightWidth;
  const color = online ? '#059669' : '#6b7280';
  const radius = style === 'flat-square' ? 0 : 4;
  const badgeLabel = style === 'for-the-badge' ? left.toUpperCase() : left;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="28" role="img" aria-label="${badgeLabel}: ${right}"><linearGradient id="b" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient><clipPath id="r"><rect width="${total}" height="28" rx="${radius}"/></clipPath><g clip-path="url(#r)"><rect width="${leftWidth}" height="28" fill="#374151"/><rect x="${leftWidth}" width="${rightWidth}" height="28" fill="${color}"/><rect width="${total}" height="28" fill="url(#b)"/></g><g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,sans-serif" font-size="11" text-rendering="geometricPrecision"><text x="${leftWidth / 2}" y="18">${badgeLabel}</text><text x="${leftWidth + rightWidth / 2}" y="18">${right}</text></g></svg>`;
}

async function authenticate(req) {
  const raw = req.headers['x-mcpulse-key'];
  if (typeof raw !== 'string' || !/^mcp_live_[A-Za-z0-9_-]{40,60}$/.test(raw)) throw new HttpError(401, 'UNAUTHORIZED', 'A valid X-MCPulse-Key header is required.');
  const keyHash = hashApiKey(raw);
  const cached = authCache.get(keyHash);
  if (cached && cached.expiresAt > Date.now()) return cached.row;
  if (cached) authCache.delete(keyHash);
  const row = await runLimited(() => findApiKey(keyHash));
  if (!row) throw new HttpError(401, 'UNAUTHORIZED', 'The API key is invalid, expired, or revoked.');
  authCache.set(keyHash, { row, expiresAt: Date.now() + AUTH_CACHE_TTL_MS });
  if (authCache.size > 10000) {
    for (const [hash, entry] of authCache) { if (entry.expiresAt <= Date.now()) authCache.delete(hash); }
    while (authCache.size > 10000) authCache.delete(authCache.keys().next().value);
  }
  return row;
}

function pruneRateBuckets(now) {
  if (now - lastRatePruneAt < 60000 && rateBuckets.size < MAX_RATE_BUCKETS) return;
  for (const [id, bucket] of rateBuckets) if (now - bucket.start > 120000) rateBuckets.delete(id);
  while (rateBuckets.size >= MAX_RATE_BUCKETS) rateBuckets.delete(rateBuckets.keys().next().value);
  lastRatePruneAt = now;
}

function getClientIp(req) {
  // Render is fronted by Cloudflare. Prefer Cloudflare's single client-IP
  // header; X-Forwarded-For can contain client-supplied values and proxy hops.
  const edgeIp = req.headers['cf-connecting-ip'];
  if (typeof edgeIp === 'string' && isIpAddress(edgeIp.trim())) return edgeIp.trim();
  return 'unknown';
}

function enforceRateLimit(keyId) {
  const now = Date.now();
  pruneRateBuckets(now);
  const bucket = rateBuckets.get(keyId) || { start: now, count: 0 };
  if (now - bucket.start >= 60000) { bucket.start = now; bucket.count = 0; }
  bucket.count++;
  rateBuckets.set(keyId, bucket);
  if (bucket.count > config.rateLimitPerMinute) throw new HttpError(429, 'RATE_LIMITED', 'This API key has exceeded its per-minute request limit.');
}

function boundedInt(value, fallback, min, max, label) {
  const parsed = value === null || value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new HttpError(400, 'INVALID_QUERY', `${label} must be a whole number from ${min} to ${max}.`);
  return parsed;
}

function requireScope(key, scope) {
  if (!Array.isArray(key.scopes) || (!key.scopes.includes(scope) && !key.scopes.includes('*'))) {
    throw new HttpError(403, 'INSUFFICIENT_SCOPE', `This API key does not have the ${scope} permission.`);
  }
}

function checkOrigin(req, res) {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (!config.corsOrigins.has(origin)) return false;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-MCPulse-Key');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Max-Age', '600');
  return true;
}

function enforceIpRateLimit(req, bucketName, limit, message) {
  const now = Date.now();
  pruneRateBuckets(now);
  const id = `${bucketName}:${getClientIp(req)}`;
  const bucket = rateBuckets.get(id) || { start: now, count: 0 };
  if (now - bucket.start >= 60000) { bucket.start = now; bucket.count = 0; }
  bucket.count++; rateBuckets.set(id, bucket);
  if (bucket.count > limit) throw new HttpError(429, 'RATE_LIMITED', message);
}

function enforcePublicRateLimit(req) {
  enforceIpRateLimit(req, 'public', 30, 'Too many public requests. Try again in a minute.');
}

function enforceAuthenticatedIpLimit(req) {
  enforceIpRateLimit(req, 'auth-ip', 120, 'Too many API requests from this network. Try again in a minute.');
}

async function persistOfflineAttempt(host, port, edition, error) {
  if (!(error instanceof HttpError) || !['TIMEOUT', 'CONNECTION_FAILED', 'INCOMPLETE_RESPONSE', 'BAD_RESPONSE'].includes(error.code)) return;
  try {
    const target = await resolveMinecraftTarget(host, port, edition);
    await runLimited(() => recordServerCheck({ host: target.hostname, port: target.port, edition, online: false, latencyMs: null }));
  } catch { /* Invalid/private destinations and DNS failures are not monitoring samples. */ }
}

export async function handle(req, res) {
  const started = Date.now();
  let key = null;
  let status = 500;
  let route = 'unknown';
  try {
    if (!checkOrigin(req, res)) throw new HttpError(403, 'ORIGIN_NOT_ALLOWED', 'This website origin is not allowed to use the API.');
    if (req.method === 'OPTIONS') { status = 204; res.writeHead(204); return res.end(); }
    if (req.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Only GET requests are supported.');
    const url = new URL(req.url, 'http://mcpulse.internal');
    route = url.pathname;

    if (route === '/v1/health') {
      status = 200;
      return json(res, status, { ok: true, service: 'MC Pulse API', version: '1.3.0-cloudflare', timestamp: new Date().toISOString() });
    }

    // Public, first-party SVG status badge backed by MC Pulse's native protocol engines.
    if (route === '/v1/badge') {
      enforcePublicRateLimit(req);
      const host = url.searchParams.get('host');
      const edition = (url.searchParams.get('edition') || 'java').toLowerCase();
      if (!host || !['java', 'bedrock'].includes(edition)) throw new HttpError(400, 'INVALID_QUERY', 'host and edition=java|bedrock are required.');
      const expectedPort = edition === 'bedrock' ? 19132 : 25565;
      const requestedPort = url.searchParams.get('port');
      if (isIpAddress(host.trim()) || (requestedPort && Number(requestedPort) !== expectedPort)) throw new HttpError(400, 'BADGE_TARGET_RESTRICTED', 'Public badges support DNS hostnames on the standard Minecraft port only. Use the authenticated server endpoint for IP addresses or custom ports.');
      const label = (url.searchParams.get('label') || host).trim().slice(0, 36) || host;
      let value = 'offline'; let online = false;
      try {
        const result = await runLimited(() => edition === 'bedrock' ? pingBedrock(host, expectedPort) : pingJava(host, expectedPort));
        online = true;
        const count = edition === 'java' ? result.players?.online : result.playersOnline;
        value = `${count ?? 0} online`;
      } catch (error) { value = error?.code === 'BEDROCK_UDP_UNAVAILABLE' ? 'UDP unavailable' : 'offline'; }
      const body = statusBadgeSvg(label, value, online, url.searchParams.get('style') || 'flat');
      status = 200;
      res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'public, max-age=30, s-maxage=30', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" });
      return res.end(body);
    }

    // Public, read-only software catalog. Download URLs are constructed from a fixed provider allowlist.
    if (route.startsWith('/v1/software/')) {
      enforcePublicRateLimit(req);
      if (route === '/v1/software/catalog') {
        status = 200;
        return json(res, status, { providers: SOFTWARE_CATALOG, note: 'Only officially published software releases with verifiable provider metadata are listed.' }, { 'Cache-Control': 'public, max-age=300' });
      }
      if (route === '/v1/software/versions') {
        const loader = url.searchParams.get('loader');
        const versions = await runLimited(() => listSoftwareVersions(loader));
        status = 200;
        return json(res, status, { loader, versions }, { 'Cache-Control': 'public, max-age=300' });
      }
      if (route === '/v1/software/builds') {
        const loader = url.searchParams.get('loader');
        const version = url.searchParams.get('version');
        const builds = await runLimited(() => listSoftwareBuilds(loader, version));
        status = 200;
        return json(res, status, { loader, version, builds }, { 'Cache-Control': 'public, max-age=300' });
      }
      if (route === '/v1/software/download') {
        const file = await runLimited(() => resolveSoftwareDownload(url.searchParams.get('loader'), url.searchParams.get('version'), url.searchParams.get('build')));
        // Prevent open redirects: every resolved URL must be HTTPS and belong to a known provider host.
        const target = new URL(file.url);
        const allowed = ['piston-data.mojang.com', 'fill-data.papermc.io', 'api.purpurmc.org', 'meta.fabricmc.net', 'maven.minecraftforge.net', 'maven.neoforged.net', 'maven.quiltmc.org', 'hub.spigotmc.org'];
        if (target.protocol !== 'https:' || !allowed.includes(target.hostname) || (target.port && target.port !== '443') || target.username || target.password) throw new HttpError(502, 'UNSAFE_DOWNLOAD_URL', 'The provider returned an unsupported download destination.');
        status = 302;
        res.writeHead(302, { Location: target.href, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        return res.end();
      }
      throw new HttpError(404, 'NOT_FOUND', 'Software endpoint not found.');
    }

    enforceAuthenticatedIpLimit(req);
    key = await authenticate(req);
    enforceRateLimit(key.id);
    if (inFlight >= MAX_IN_FLIGHT) throw new HttpError(503, 'BUSY', 'The API is handling its maximum number of concurrent requests. Try again shortly.');

    if (route === '/v1/server/java') {
      requireScope(key, 'servers:read');
      const host = url.searchParams.get('host');
      let result;
      try { result = await runLimited(() => pingJava(host, url.searchParams.get('port'))); }
      catch (error) { await persistOfflineAttempt(host, url.searchParams.get('port'), 'java', error); throw error; }
      await runLimited(() => recordServerCheck(result)).catch(err => console.error('Could not persist server check:', err.message));
      status = 200;
      return json(res, status, result);
    }
    if (route === '/v1/server/bedrock') {
      requireScope(key, 'servers:read');
      const host = url.searchParams.get('host');
      let result;
      try { result = await runLimited(() => pingBedrock(host, url.searchParams.get('port'))); }
      catch (error) { await persistOfflineAttempt(host, url.searchParams.get('port'), 'bedrock', error); throw error; }
      await runLimited(() => recordServerCheck(result)).catch(err => console.error('Could not persist server check:', err.message));
      status = 200;
      return json(res, status, result);
    }
    if (route === '/v1/server/history') {
      requireScope(key, 'monitoring:read');
      const host = url.searchParams.get('host');
      const port = boundedInt(url.searchParams.get('port'), NaN, 1024, 65535, 'port');
      const edition = url.searchParams.get('edition');
      if (!host || !['java', 'bedrock'].includes(edition)) throw new HttpError(400, 'INVALID_QUERY', 'host, port, and edition=java|bedrock are required.');
      const limit = boundedInt(url.searchParams.get('limit'), 100, 1, 500, 'limit');
      const rows = await runLimited(() => getServerHistory(host, port, edition, limit));
      status = 200;
      return json(res, status, { host, port, edition, checks: rows });
    }
    if (route === '/v1/server/daily-history') {
      requireScope(key, 'monitoring:read');
      const host = url.searchParams.get('host');
      const port = boundedInt(url.searchParams.get('port'), NaN, 1024, 65535, 'port');
      const edition = url.searchParams.get('edition');
      if (!host || !['java', 'bedrock'].includes(edition)) throw new HttpError(400, 'INVALID_QUERY', 'host, port, and edition=java|bedrock are required.');
      const days = boundedInt(url.searchParams.get('days'), 30, 1, 365, 'days');
      const rows = await runLimited(() => getDailyServerHistory(host, port, edition, days));
      status = 200;
      return json(res, status, { host, port, edition, days: rows });
    }
    if (route === '/v1/player/profile') {
      requireScope(key, 'players:read');
      const query = validatePlayerQuery(url.searchParams.get('query'));
      const profile = await runLimited(() => import('./players.js').then(m => m.getPlayerProfile(query)));
      status = 200;
      return json(res, status, profile);
    }
    throw new HttpError(404, 'NOT_FOUND', 'Endpoint not found. See the MC Pulse API route list in README.md.');
  } catch (error) {
    status = error instanceof HttpError ? error.status : 502;
    const code = error instanceof HttpError ? error.code : 'UPSTREAM_ERROR';
    const message = error instanceof HttpError ? error.message : 'The request could not be completed.';
    if (!res.headersSent) json(res, status, { error: { code, message } });
  } finally {
    if (key) runLimited(() => recordUsage(key.id, route, status, Date.now() - started)).catch(() => {});
  }
}

async function runLimited(fn) {
  if (inFlight >= MAX_IN_FLIGHT) throw new HttpError(503, 'BUSY', 'The API is handling its maximum number of concurrent requests. Try again shortly.');
  inFlight++;
  try { return await fn(); } finally { inFlight--; }
}


class WorkerResponse {
  constructor() { this.headers = new Headers(); this.statusCode = 200; this.body = null; this.response = null; this.headersSent = false; }
  setHeader(name, value) { this.headers.set(name, String(value)); }
  writeHead(status, headers = {}) { this.statusCode = status; for (const [name, value] of Object.entries(headers)) this.headers.set(name, String(value)); this.headersSent = true; return this; }
  end(body = null) { this.body = body; this.response = new Response(body, { status: this.statusCode, headers: this.headers }); return this.response; }
}

export async function handleWorkerRequest(request, env) {
  const { initializeConfig } = await import('./config.js');
  initializeConfig(env);
  const headers = Object.fromEntries(request.headers.entries());
  const req = { method: request.method, url: request.url, headers };
  const res = new WorkerResponse();
  await handle(req, res);
  return res.response || new Response(JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'No response was generated.' } }), { status: 500, headers: { 'Content-Type': 'application/json' } });
}
