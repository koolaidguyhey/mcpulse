# Security policy

## Supported releases

Security fixes are applied to the latest published MC Pulse release. Deployments should use the latest tagged release and keep the backend runtime on a supported Node.js LTS line.

## Reporting a vulnerability

Do not publish API keys, service-role credentials, personal information, or an exploitable vulnerability in a public issue. Contact the project maintainer privately through the repository's GitHub security reporting feature when it is enabled. If private reporting is unavailable, contact the maintainer directly before sharing technical details publicly.

## Deployment security requirements

- Keep `SUPABASE_SERVICE_ROLE_KEY` and `API_KEY_PEPPER` only in the backend environment.
- Never commit `.env` files, generated API keys, or database credentials.
- Configure `CORS_ORIGINS` with exact trusted frontend origins only.
- Use HTTPS for the Supabase project and public deployment.
- Revoke API keys that are exposed or no longer needed.
- Do not expose the backend's service-role key in frontend code, browser storage, screenshots, or issue reports.
