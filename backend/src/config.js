function boundedNumber(name, raw, fallback, min, max) {
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  return value;
}

export let config = null;

export function initializeConfig(env) {
  const supabaseKey = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
  const supabaseKeyMode = env.SUPABASE_SECRET_KEY ? 'secret' : 'legacy';
  const required = ['SUPABASE_URL', 'API_KEY_PEPPER'];
  for (const name of required) if (!env[name]) throw new Error(`Missing required Worker secret or variable: ${name}`);
  if (!supabaseKey) throw new Error('Missing required Worker secret: SUPABASE_SECRET_KEY (preferred) or SUPABASE_SERVICE_ROLE_KEY (legacy).');
  if (new TextEncoder().encode(env.API_KEY_PEPPER).length < 32) throw new Error('API_KEY_PEPPER must be at least 32 bytes.');
  let supabase;
  try { supabase = new URL(env.SUPABASE_URL); } catch { throw new Error('SUPABASE_URL must be a valid HTTPS URL.'); }
  if (supabase.protocol !== 'https:' || !supabase.hostname || supabase.username || supabase.password || supabase.pathname !== '/' || supabase.search || supabase.hash) {
    throw new Error('SUPABASE_URL must be an HTTPS project URL without credentials, query parameters, or fragments.');
  }
  const corsOrigins = (env.CORS_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean);
  for (const origin of corsOrigins) {
    let parsed;
    try { parsed = new URL(origin); } catch { throw new Error(`CORS_ORIGINS contains an invalid origin: ${origin}`); }
    const localHttp = parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
    if ((!localHttp && parsed.protocol !== 'https:') || parsed.origin !== origin || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw new Error(`CORS_ORIGINS entries must be exact HTTPS origins (or localhost for development): ${origin}`);
    }
  }
  config = Object.freeze({
    supabaseUrl: supabase.origin,
    supabaseKey,
    supabaseKeyMode,
    apiKeyPepper: env.API_KEY_PEPPER,
    corsOrigins: new Set(corsOrigins),
    requestTimeoutMs: boundedNumber('REQUEST_TIMEOUT_MS', env.REQUEST_TIMEOUT_MS, 5000, 1000, 10000),
    rateLimitPerMinute: boundedNumber('RATE_LIMIT_PER_MINUTE', env.RATE_LIMIT_PER_MINUTE, 60, 5, 300)
  });
  return config;
}
