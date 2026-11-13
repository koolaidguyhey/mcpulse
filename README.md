# MC Pulse — Cloudflare Edition

**Version:** 1.3.0 (Cloudflare Workers migration)

MC Pulse is a Minecraft server status dashboard, player profile lookup, server-software catalog, and first-party API.

## Hosting layout

- **GitHub Pages:** serves `frontend/` as the static dashboard.
- **Cloudflare Workers Free:** runs `worker.js` and the API modules under `backend/src/`.
- **Supabase Free:** stores API-key hashes, usage records, and server history.

This version is adapted for Cloudflare Workers. It does not use Render or Google Cloud.

## Important compatibility notes

- **Minecraft Java:** direct Java Server List Ping is implemented over Cloudflare outbound TCP sockets. The Worker resolves A/AAAA and SRV records through DNS-over-HTTPS and rejects private/reserved destinations before opening a socket.
- **Minecraft Bedrock:** direct RakNet status requires UDP. Cloudflare Workers does not provide general outbound UDP sockets, so `/v1/server/bedrock` returns `501 BEDROCK_UDP_UNAVAILABLE`. The badge labels this as unavailable rather than falsely reporting the server offline. A separate UDP-capable free service would be needed to restore direct Bedrock checks.
- **Player profiles:** retrieved from Mojang's official profile endpoints.
- **Software Center:** reads official metadata and redirects downloads to the validated official provider hosts.
- **Monitoring:** server checks are persisted when the API is queried. Daily database cleanup/rollup runs using a Cloudflare Cron Trigger.

Cloudflare's current Free Workers allowance is 100,000 requests per day, 10 ms CPU time per invocation, 128 MB memory, and six simultaneous outgoing connections per request. These limits can change; check the official [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and [pricing](https://developers.cloudflare.com/workers/platform/pricing/) pages. The Free plan is ongoing but its terms are not a promise that prices/limits will never change. If a limit is exceeded, requests or operations may fail; this project does not automatically upgrade your account.

## 1. Create the Supabase database

1. Create a Supabase project using the Free plan.
2. Open **SQL Editor**.
3. Open `database/schema.sql` from this repository, copy its full contents, paste into SQL Editor, and run it.
4. In Supabase project settings, copy the project URL and the **Secret key** (`sb_secret_...`) from Settings → API Keys. Treat it as a password. This release supports the current Secret key format. Older projects may use the legacy `service_role` key as a temporary compatibility option, but Supabase is deprecating legacy keys by the end of 2026. Never put it in frontend code or commit it to GitHub.

Supabase Free has its own database, egress, and inactivity limits. Review [Supabase pricing](https://supabase.com/pricing).

## 2. Upload the project to GitHub

Upload the contents of this project directory to a GitHub repository. Keep the folder structure intact, especially `worker.js`, `wrangler.toml`, `backend/`, `database/`, and `frontend/`.

Do not upload `.dev.vars`, `.env`, or any real credentials. The `.gitignore` excludes them.

## 3. Connect the existing Cloudflare Worker to GitHub

The Worker name in the dashboard must match `name = "mc-pulse-api"` in `wrangler.toml`.

1. Open Cloudflare Dashboard → **Workers & Pages**.
2. Select the existing `mc-pulse-api` Worker you created with Hello World.
3. Open **Settings** → **Builds**.
4. Choose **Connect** and authorize the Cloudflare Workers & Pages GitHub app.
5. Select your MC Pulse repository and the `main` branch.
6. Set the **Root directory** to `/` if you uploaded the project files directly into the repository root. If you put them inside a `mc-pulse/` folder, set the root directory to `/mc-pulse`.
7. Leave the optional build command empty. Set the deploy command to `npx wrangler deploy` if Cloudflare does not fill it in automatically.
8. Save. Push a commit to `main` to trigger deployment.

Cloudflare's official instructions: [Connect an existing Worker to Git](https://developers.cloudflare.com/workers/ci-cd/builds/).

## 4. Add Worker runtime variables and secrets

Open the `mc-pulse-api` Worker → **Settings** → **Variables and Secrets** (the exact label may vary).

Add these runtime values for the **Production** environment:

| Name | Type | Value |
|---|---|---|
| `SUPABASE_URL` | Text | Your Supabase project URL, e.g. `https://project-ref.supabase.co` |
| `CORS_ORIGINS` | Text | Exact GitHub Pages origin, e.g. `https://YOUR-USERNAME.github.io` |
| `REQUEST_TIMEOUT_MS` | Text | `5000` |
| `RATE_LIMIT_PER_MINUTE` | Text | `60` |

Add these as **Secrets**, not ordinary text variables:

| Name | Value |
|---|---|
| `SUPABASE_SECRET_KEY` | Supabase Secret key (`sb_secret_...`) |
| `API_KEY_PEPPER` | A random secret at least 32 bytes long |

For GitHub Pages project sites, the origin is still `https://YOUR-USERNAME.github.io` — do not include the repository path. If you use a custom domain, use its exact HTTPS origin instead.

Save the variables and secrets, then redeploy the Worker. Never put secret values in GitHub, `wrangler.toml`, frontend HTML, screenshots, or chat messages.

## 5. Create your first MC Pulse API key

The key creation script runs locally and inserts only an HMAC-SHA256 hash into Supabase. On a computer with Node.js 22 or newer:

```bash
cd backend
cp .env.example .env
nano .env
```

Fill `.env` with the same `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, and exact same `API_KEY_PEPPER` configured as the Worker secret. You can generate a pepper locally with:

```bash
openssl rand -hex 32
```

Keep the generated pepper private. Use the same value in `.env` and the Worker secret. Then create a key:

```bash
node --env-file=.env scripts/create-key.js --label="My MC Pulse Dashboard" --scopes=servers:read,players:read,monitoring:read
```

The full API key is displayed once. Copy it and keep it private. Do not commit `.env` or paste the key into a public issue. To revoke a key later:

```bash
node --env-file=.env scripts/revoke-key.js --id=THE-KEY-UUID
```

## 6. Deploy the frontend to GitHub Pages

1. In your GitHub repository, open **Settings → Pages**.
2. Under Build and deployment, choose **GitHub Actions**.
3. Push to `main`. The included `.github/workflows/pages.yml` publishes only `frontend/`.
4. Open the GitHub Pages URL.
5. Open the API settings in MC Pulse. The Worker URL is prefilled as `https://mc-pulse-api.tamojit-sarkar21.workers.dev` for this deployment. If you create a different Worker name/subdomain, replace it with your actual URL.
6. Select **MC Pulse API**, apply the endpoint, and import the API key you created.

## 7. Test the Worker

Open:

```text
https://mc-pulse-api.tamojit-sarkar21.workers.dev/v1/health
```

Expected response shape:

```json
{"ok":true,"service":"MC Pulse API","version":"1.3.0-cloudflare","timestamp":"..."}
```

Then test the public software catalog:

```text
https://mc-pulse-api.tamojit-sarkar21.workers.dev/v1/software/catalog
```

Finally test Java status from the dashboard with your API key. Confirm that CORS allows the published GitHub Pages origin. A successful `/v1/health` check alone does not verify Supabase credentials, TCP connectivity, profile lookups, or provider APIs.

## API routes

Public, rate-limited:

- `GET /v1/health`
- `GET /v1/badge?host=example.org&edition=java&label=Example`
- `GET /v1/software/catalog`
- `GET /v1/software/versions?loader=vanilla`
- `GET /v1/software/builds?loader=paper&version=1.21.4`
- `GET /v1/software/download?loader=vanilla&version=1.21.4&build=official`

API-key protected with `X-MCPulse-Key`:

- `GET /v1/server/java?host=example.org&port=25565` — `servers:read`
- `GET /v1/server/bedrock?host=example.org&port=19132` — currently returns `501 BEDROCK_UDP_UNAVAILABLE`
- `GET /v1/server/history?host=example.org&port=25565&edition=java&limit=100` — `monitoring:read`
- `GET /v1/server/daily-history?host=example.org&port=25565&edition=java&days=30` — `monitoring:read`
- `GET /v1/player/profile?query=Notch` — `players:read`

## Security and operations

- Supabase service-role key and API key pepper are Worker Secrets only.
- API keys are generated locally; only keyed hashes are stored in Supabase.
- Private/reserved IPs are rejected before TCP connections. Do not remove these checks.
- Public software downloads are restricted to known official provider hosts.
- Per-isolate in-memory rate limits and caches are best-effort; they reset when isolates restart. They are not a substitute for a globally coordinated rate limiter.
- The daily Cron Trigger runs the Supabase history rollup and deletes API usage records older than 30 days.
- Workers Free has strict CPU and request limits. Test real Minecraft server responses and check Worker logs before relying on it.

## Validation status

The local automated suite covers configuration validation, API-key hashing, public/private IP filtering, Java packet construction/parsing, and software metadata/download validation. It does **not** prove that Cloudflare's production TCP socket can reach every Minecraft host, that Supabase credentials are correctly configured, or that all provider APIs are currently available. Complete those checks after deployment. Direct Bedrock UDP is intentionally not claimed as supported.
