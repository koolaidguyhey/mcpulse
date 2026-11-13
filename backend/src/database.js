import { config } from './config.js';

async function rest(path, options = {}) {
  const response = await fetch(`${config.supabaseUrl}/rest/v1/${path}`, {
    ...options,
    headers: { apikey: config.supabaseKey, ...(config.supabaseKeyMode === 'legacy' ? { Authorization: `Bearer ${config.supabaseKey}` } : {}), 'Content-Type': 'application/json', ...(options.headers || {}) },
    signal: AbortSignal.timeout(7000), redirect: 'error'
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Supabase request failed (${response.status}): ${detail.slice(0, 300)}`);
  }
  if (response.status === 204) return null;
  return response.json();
}

export async function findApiKey(keyHash) {
  const query = new URLSearchParams({ select: 'id,label,scopes,revoked_at,expires_at', key_hash: `eq.${keyHash}`, limit: '1' });
  const rows = await rest(`api_keys?${query}`);
  const row = rows[0];
  if (!row || row.revoked_at || (row.expires_at && Date.parse(row.expires_at) <= Date.now())) return null;
  return row;
}

export async function recordUsage(apiKeyId, route, statusCode, durationMs) {
  return rest('api_usage', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ api_key_id: apiKeyId, route, status_code: statusCode, duration_ms: durationMs })
  });
}

export async function recordServerCheck(result) {
  return rest('server_checks', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      host: result.host, port: result.port, edition: result.edition,
      online: result.online, latency_ms: result.latencyMs,
      checked_at: new Date().toISOString(),
      payload: result.edition === 'java' ? { version: result.version?.name || null, protocol: result.version?.protocol || null, players: result.players ? { online: result.players.online, max: result.players.max } : null } : { version: result.version || null, protocol: result.protocol || null, playersOnline: result.playersOnline, playersMax: result.playersMax, motd: (result.motd || '').slice(0, 160) }
    })
  });
}

export async function getServerHistory(host, port, edition, limit = 100) {
  const query = new URLSearchParams({
    select: 'host,port,edition,online,latency_ms,checked_at',
    host: `eq.${host}`, port: `eq.${port}`, edition: `eq.${edition}`,
    order: 'checked_at.desc', limit: String(limit)
  });
  return rest(`server_checks?${query}`);
}


export async function getDailyServerHistory(host, port, edition, limit = 30) {
  const query = new URLSearchParams({
    select: 'host,port,edition,day,total_checks,online_checks,avg_latency_ms,min_latency_ms,max_latency_ms',
    host: `eq.${host}`, port: `eq.${port}`, edition: `eq.${edition}`,
    order: 'day.desc', limit: String(limit)
  });
  return rest(`server_daily_stats?${query}`);
}

export async function runMaintenance() {
  await rest('rpc/rollup_server_history', { method: 'POST', body: '{}' });
  const usageCutoff = new Date(Date.now() - 30 * 86400000).toISOString();
  const usageQuery = new URLSearchParams({ created_at: `lt.${usageCutoff}` });
  await rest(`api_usage?${usageQuery}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
}

