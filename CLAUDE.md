# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Start development server (auto-restarts on changes)
vercel dev

# Sync API routes to Postman collection
npm run postman:sync
```

The server runs on port 4000 by default (override with `PORT` env var). Environment is loaded from `.env.local` first, then `.env`.

## Architecture

This is a **Node.js/Express REST API** for the Infavy video streaming platform, deployed on **Vercel serverless** (`/api/index.js` is the Vercel entry point; `/src/app.js` is the Express app used for local dev).

### Request Lifecycle

Every request goes through:
1. CORS validation against `ALLOWED_ORIGINS`
2. User-Agent parsing (device/platform detection attached to `req.useragent`)
3. Request logging with a 28-second safety timeout
4. Basic Auth gate (if `UI_BASIC_USER`/`UI_BASIC_PASS` env vars are set)
5. Route handler

Webhook routes (`/api/v1/webhooks/razorpay`, `/api/v1/webhooks/revenuecat`) bypass JSON body parsing to allow raw body signature verification.

### Route Organization

All API routes are registered in [src/apis.js](src/apis.js) under `/api/v1/`. Route files live in [src/routes/](src/routes/) and delegate to controllers or inline handlers. Key domains:

- **Auth** — Firebase-based phone OTP, email/password, magic link, custom tokens
- **Home** — Hero, grid, up-next, video detail, similar videos (content feed)
- **Channels/Videos** — CRUD and metadata
- **Watchlist/Likes** — User engagement
- **Subscriptions/UserSubscriptions** — Subscription state management
- **Webhooks** — Razorpay (payments) and RevenueCat (mobile subscriptions)

### Service Layer

Business logic lives in [src/services/](src/services/):
- `auth.service.js` — Firebase Auth operations (custom tokens, phone OTP flow)
- `revenuecatWebhook.service.js` — RevenueCat event processing and subscription state transitions
- `expireSubscriptions.js` — Subscription expiration logic

### Database

**Firestore** (Firebase Admin SDK) is the primary database. The Admin SDK is initialized in [src/lib/firebaseAdmin.js](src/lib/firebaseAdmin.js) using `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, and `FIREBASE_PRIVATE_KEY` env vars.

### Key Integrations

| Integration | Purpose | Env vars prefix |
|---|---|---|
| Firebase Admin | Auth + Firestore DB | `FIREBASE_*` |
| RevenueCat | Mobile subscription webhooks | `PUBLIC_REVENUECAT_*` |
| Razorpay | Payment webhooks | `RAZORPAY_WEBHOOK_SECRET` |
| Mux | Video streaming tokens | `MUX_TOKEN_*` |
| DLT SMS Gateway | OTP SMS delivery | `DLT_*` |
| SMTP | Email notifications | `SMTP_*` |

Webhook signatures are verified in [src/lib/razorpaySignature.js](src/lib/razorpaySignature.js) and [src/lib/revenuecatSignature.js](src/lib/revenuecatSignature.js) before any processing.

### API Explorer UI

`GET /` serves an interactive HTML API explorer ([src/ui.js](src/ui.js)). It reads endpoint metadata from `/api/endpoints` and renders markdown docs from `/api/docs/{NAME}` (sourced from [api_documentation/](api_documentation/)). Protected by HTTP Basic Auth when `UI_BASIC_USER`/`UI_BASIC_PASS` are set.

### OTP Rate Limiting

[src/middleware/rateLimiter.js](src/middleware/rateLimiter.js) enforces 3 OTP requests per phone number per 10 minutes and 3 per IP, using in-memory Maps (resets on server restart).

## Postman Sync

`npm run postman:sync` runs [scripts/generate-and-push-postman.js](scripts/generate-and-push-postman.js), which extracts OpenAPI/Swagger docs (via swagger-jsdoc) from JSDoc comments in route files and pushes the generated Postman collection to the Postman API. Requires `POSTMAN_API_KEY` and `POSTMAN_COLLECTION_UID` env vars.
