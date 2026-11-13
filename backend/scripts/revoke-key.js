const { SUPABASE_URL } = process.env;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const USE_LEGACY_KEY = !process.env.SUPABASE_SECRET_KEY;
const id = process.argv.find(x => x.startsWith('--id='))?.slice(5);
let supabaseUrl;
try { supabaseUrl = new URL(SUPABASE_URL); } catch { supabaseUrl = null; }
if (!supabaseUrl || supabaseUrl.protocol !== 'https:' || supabaseUrl.pathname !== '/' || supabaseUrl.username || supabaseUrl.password || supabaseUrl.search || supabaseUrl.hash || !SUPABASE_KEY || !id || !/^[0-9a-f-]{36}$/i.test(id)) {
  console.error('Usage: node --env-file=.env scripts/revoke-key.js --id=<key-uuid>');
  process.exit(1);
}
const url = new URL('/rest/v1/api_keys', supabaseUrl.origin);
url.searchParams.set('id', `eq.${id}`);
const response = await fetch(url, {
  method: 'PATCH',
  headers: {
    apikey: SUPABASE_KEY,
    ...(USE_LEGACY_KEY ? { Authorization: `Bearer ${SUPABASE_KEY}` } : {}),
    'Content-Type': 'application/json',
    Prefer: 'return=representation'
  },
  body: JSON.stringify({ revoked_at: new Date().toISOString() })
});
if (!response.ok) {
  console.error(`Supabase rejected revocation (${response.status}): ${await response.text()}`);
  process.exit(1);
}
const rows = await response.json();
if (!rows.length) {
  console.error('No API key found with that ID.');
  process.exit(1);
}
console.log(`Revoked API key ${id}. It may remain usable for up to five seconds due to the backend auth cache.`);
