# Infavy API — Quick Reference

Base URL: `https://infavy-api-server.vercel.app`

This repository exposes a small set of HTTP endpoints mounted under `/api/v1` plus a few root routes. See the per-area reference files in `api_documentation/` for full request/response examples and environment notes.

Main API groups and where to find detailed docs:

- Auth: [api_documentation/AUTH_API.md](api_documentation/AUTH_API.md)
- Home (hero, grid, current video, similar, up-next): [api_documentation/HOME_API.md](api_documentation/HOME_API.md)
- Videos list: [api_documentation/VIDEOS_API.md](api_documentation/VIDEOS_API.md)
- Channels CRUD: [api_documentation/CHANNELS_API.md](api_documentation/CHANNELS_API.md)
- Likes: [api_documentation/LIKES_API.md](api_documentation/LIKES_API.md)
- Subscriptions: [api_documentation/SUBSCRIPTIONS_API.md](api_documentation/SUBSCRIPTIONS_API.md)
- Watchlist: [api_documentation/WATCHLIST_API.md](api_documentation/WATCHLIST_API.md)

Small examples and testing tips are included in the individual files. Use `GET /api/v1/ping` for a quick heartbeat; `GET /health` is available at the root for system checks.

If you want, I can now run a quick pass verifying there are no remaining wrong base-path mentions in the documentation files and fix them automatically.