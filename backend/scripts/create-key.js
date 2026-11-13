import crypto from 'node:crypto';

const { SUPABASE_URL, API_KEY_PEPPER } = process.env;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const USE_LEGACY_KEY = !process.env.SUPABASE_SECRET_KEY;
let supabaseUrl;
try { supabaseUrl = new URL(SUPABASE_URL); } catch { supabaseUrl = null; }
if (!supabaseUrl || supabaseUrl.protocol !== 'https:' || supabaseUrl.pathname !== '/' || supabaseUrl.username || supabaseUrl.password || supabaseUrl.search || supabaseUrl.hash || !SUPABASE_KEY || !API_KEY_PEPPER || Buffer.byteLength(API_KEY_PEPPER) < 32) {
  console.error('Set SUPABASE_URL, SUPABASE_SECRET_KEY (preferred) or SUPABASE_SERVICE_ROLE_KEY (legacy), and a 32+ byte API_KEY_PEPPER first.');
  process.exit(1);
}
const args = process.argv.slice(2);
const value = (name, fallback) => args.find(x => x.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const label = value('label', 'MC Pulse API Key').trim().slice(0, 64);
const scopes = value('scopes', 'servers:read,players:read,monitoring:read').split(',').map(x => x.trim()).filter(Boolean);
const allowed = new Set(['servers:read', 'players:read', 'monitoring:read']);
if (!label || !scopes.length || scopes.some(scope => !allowed.has(scope))) {
  console.error('Invalid label or scopes. Allowed scopes: servers:read, players:read, monitoring:read');
  process.exit(1);
}
const apiKey = `mcp_live_${crypto.randomBytes(32).toString('base64url')}`;
const keyHash = crypto.createHmac('sha256', API_KEY_PEPPER).update(apiKey).digest('hex');
const response = await fetch(`${supabaseUrl.origin}/rest/v1/api_keys`, {
  method: 'POST',
  headers: {
    apikey: SUPABASE_KEY,
    ...(USE_LEGACY_KEY ? { Authorization: `Bearer ${SUPABASE_KEY}` } : {}),
    'Content-Type': 'application/json',
    Prefer: 'return=representation'
  },
  body: JSON.stringify({ label, key_hash: keyHash, scopes })
});
if (!response.ok) {
  console.error(`Supabase rejected key creation (${response.status}): ${await response.text()}`);
  process.exit(1);
}
const rows = await response.json();
console.log('\nMC Pulse API key created. Copy it now; it cannot be retrieved later.\n');
console.log(apiKey);
console.log(`\nKey ID: ${rows[0]?.id || 'created'}\nScopes: ${scopes.join(', ')}\n`);
