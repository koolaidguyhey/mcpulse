import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const node = process.execPath;
const moduleUrl = new URL('../src/config.js', import.meta.url).href;
const baseEnv = {
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_SECRET_KEY: 'sb_secret_test-key',
  API_KEY_PEPPER: '01234567890123456789012345678901',
  CORS_ORIGINS: 'https://example.github.io'
};
function loadConfig(overrides = {}) {
  return spawnSync(node, ['--input-type=module', '-e', `const m=await import(${JSON.stringify(moduleUrl)}); const config=m.initializeConfig(process.env); process.stdout.write(JSON.stringify({url:config.supabaseUrl, origins:[...config.corsOrigins]}));`], {
    encoding: 'utf8', env: { ...process.env, ...baseEnv, ...overrides }
  });
}
test('configuration accepts valid Cloudflare Worker bindings', () => {
  const result = loadConfig();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { url: 'https://project.supabase.co', origins: ['https://example.github.io'] });
});
test('configuration accepts the legacy service_role key for compatibility', () => {
  const { SUPABASE_SECRET_KEY, ...legacyEnv } = baseEnv;
  legacyEnv.SUPABASE_SERVICE_ROLE_KEY = 'legacy-service-role-key';
  const result = spawnSync(node, ['--input-type=module', '-e', `const m=await import(${JSON.stringify(moduleUrl)}); const c=m.initializeConfig(process.env); process.stdout.write(c.supabaseKeyMode);`], { encoding: 'utf8', env: { ...process.env, ...legacyEnv } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'legacy');
});
test('configuration rejects non-HTTPS public CORS origins', () => {
  const result = loadConfig({ CORS_ORIGINS: 'http://example.com' });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /CORS_ORIGINS entries must be exact HTTPS origins/);
});
test('configuration rejects CORS origins containing paths', () => {
  const result = loadConfig({ CORS_ORIGINS: 'https://example.github.io/project' });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /CORS_ORIGINS entries must be exact HTTPS origins/);
});
test('configuration rejects weak API key peppers', () => {
  const result = loadConfig({ API_KEY_PEPPER: 'too-short' });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /API_KEY_PEPPER must be at least 32 bytes/);
});
