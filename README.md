# @infavy/api-server

Minimal backend API for Infavy (mobile & web clients).

Run (from repository root):

```powershell
pnpm -w install
pnpm --filter @infavy/api-server dev
```

Available routes:
- `GET /health` - health check
- `GET /api/v1/ping` - simple ping
- `POST /api/v1/auth/login` - login stub (email + password)

Homepage APIs:
- `GET /api/v1/home/hero` - Returns ordered featured videos used by the homepage hero. See `api_documentation/HOME_API.md` for full details.

Configure via `.env` or environment variables:
- `PORT` (default 4000)
- `ALLOWED_ORIGINS` (comma-separated origins, default `*`)
