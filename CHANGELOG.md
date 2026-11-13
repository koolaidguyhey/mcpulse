# Changelog

## 1.3.0 — Cloudflare Workers migration

- Replaced the Render/Node HTTP server deployment with a Cloudflare Workers fetch handler.
- Added Cloudflare outbound TCP sockets for Java Edition Server List Ping.
- Replaced Node DNS resolution with DNS-over-HTTPS for A, AAAA, and Java SRV records, retaining public-address validation.
- Connected runtime configuration to Cloudflare Worker variables and secrets.
- Preserved Supabase REST persistence, API-key authentication/scopes, player lookup, server history, badges, and official software catalog/download routes.
- Added a daily Cloudflare Cron Trigger for history rollup and API usage retention.
- Explicitly reports direct Bedrock RakNet UDP as unsupported on Workers instead of silently pretending it works.
- Updated the frontend's default API endpoint to the user's existing Cloudflare Worker URL.
- Added Cloudflare deployment documentation and local tests for Worker-compatible modules.

## 1.3.1
- Added support for Supabase's current `sb_secret_` API keys; legacy `service_role` remains temporarily supported.
- Uses the Supabase Secret key as the `apikey` header rather than treating it as a JWT bearer token.
