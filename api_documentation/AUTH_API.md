# Auth API Documentation

This document describes the authentication-related HTTP endpoints exposed by the `@infavy/api-server` package.

**Base path**: `/api/v1/auth`

**Server port**: default `4000` (configurable via `PORT`)

**Environment variables** (required/optional)
- `NEXT_PUBLIC_FIREBASE_API_KEY` or `FIREBASE_API_KEY` — Firebase Web/API key used by REST Identity Toolkit endpoints (required for `/login` and `/magic-link`).
- `FIREBASE_PROJECT_ID` (or `NEXT_PUBLIC_FIREBASE_PROJECT_ID`) — Firebase project id used by Admin SDK.
- `FIREBASE_CLIENT_EMAIL` — service account client email for Firebase Admin.
- `FIREBASE_PRIVATE_KEY` — service account private key for Firebase Admin. In `.env` escape newlines as `\\n`.
- `FRONTEND_URL` or `NEXT_PUBLIC_APP_URL` — optional continue URL used by magic links (defaults to `http://localhost:3000/login`).

NOTE: Do not commit Admin credentials to source control. Put `packages/api-server/.env` in `.gitignore`.

--

**Endpoints**

- POST `/signup`
  - Purpose: Create a new Firebase Auth user (email/password) using Firebase Admin and return a Firebase custom token the client can exchange.
  - Body (JSON): `{ "email": "user@example.com", "password": "secret123" }`
  - Success (200): `{ "uid": "<firebase-uid>", "customToken": "<custom-token>" }`
  - Errors:
    - 400: missing email/password
    - 409: email already in use
    - 500: admin credentials not configured or server-side failure
  - Notes: Client should call `signInWithCustomToken(customToken)` (Firebase client SDK) or exchange the custom token via Identity Toolkit REST to get an `idToken`.

- POST `/login`
  - Purpose: Sign in with email/password using Firebase Identity Toolkit REST API and return `idToken` + `refreshToken`.
  - Body (JSON): `{ "email": "user@example.com", "password": "secret123" }`
  - Success (200): JSON returned by Identity Toolkit with fields like `idToken`, `refreshToken`, `expiresIn`, `localId`, `email`.
  - Errors:
    - 400: missing email/password
    - 500: missing API key on server
    - 401: invalid credentials (forwarded from Firebase)
  - Notes: This endpoint requires a Firebase Web API key (`NEXT_PUBLIC_FIREBASE_API_KEY` or `FIREBASE_API_KEY`).

- POST `/magic-link`
  - Purpose: Server-side send of an email sign-in (magic) link via Identity Toolkit `sendOobCode`. The server checks Firestore `users` collection for an existing profile before sending.
  - Body (JSON): `{ "email": "user@example.com" }`
  - Success (200): `{ "success": true }`
  - Errors:
    - 400: missing email
    - 404: no account found for the email (server checks Firestore `users` collection)
    - 500: missing API key or server error
  - Notes: The magic link is delivered by Firebase to the user's email. The web client should complete sign-in with `completeSignInWithEmailLink` (client SDK) as implemented in the web app.

- POST `/verify-token`
  - Purpose: Verify an `idToken` (Firebase ID token) using Firebase Admin and return decoded claims.
  - Body (JSON): `{ "idToken": "<id-token>" }`
  - Success (200): `{ "decoded": { /* decoded claims */ } }`
  - Errors:
    - 400: missing idToken
    - 500: admin not configured
    - 401: invalid token

- GET `/me`
  - Purpose: Convenience protected route that verifies the `Authorization: Bearer <idToken>` header and returns the user's UID and token claims.
  - Headers: `Authorization: Bearer <idToken>`
  - Success (200): `{ "uid": "<uid>", "claims": { /* decoded claims */ } }`
  - Errors:
    - 401: missing or invalid token
    - 500: admin not configured

--

**Example PowerShell calls**

- Login (email/password):
```powershell
$body = @{ email = 'test+api@example.com'; password = 'secretPass123' } | ConvertTo-Json
Invoke-RestMethod -Uri http://localhost:4000/api/v1/auth/login -Method POST -Body $body -ContentType 'application/json'
```

- Signup (returns `customToken`):
```powershell
$body = @{ email = 'test+api@example.com'; password = 'secretPass123' } | ConvertTo-Json
Invoke-RestMethod -Uri http://localhost:4000/api/v1/auth/signup -Method POST -Body $body -ContentType 'application/json'
```

- Exchange `customToken` for `idToken` (Identity Toolkit REST):
```powershell
$body = @{ token = '<CUSTOM_TOKEN>'; returnSecureToken = $true } | ConvertTo-Json
Invoke-RestMethod -Uri "https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=<YOUR_FIREBASE_API_KEY>" -Method POST -Body $body -ContentType 'application/json'
```

- Verify token via server:
```powershell
$body = @{ idToken = '<ID_TOKEN_FROM_LOGIN>' } | ConvertTo-Json
Invoke-RestMethod -Uri http://localhost:4000/api/v1/auth/verify-token -Method POST -Body $body -ContentType 'application/json'
```

- Call protected `/me`:
```powershell
$token = '<ID_TOKEN_FROM_LOGIN>'
Invoke-RestMethod -Uri http://localhost:4000/api/v1/auth/me -Method GET -Headers @{ Authorization = "Bearer $token" }
```

**curl example**
```bash
curl -X POST http://localhost:4000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test+api@example.com","password":"secretPass123"}'
```

**Node quick-test snippet**
Add this to `scripts/test-auth.js` (optional):
```javascript
const fetch = require('node-fetch');

async function post(path, body) {
  const res = await fetch(`http://localhost:4000${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  console.log(path, res.status, json);
  return json;
}

(async () => {
  const s = await post('/api/v1/auth/signup', { email: 'test+node@example.com', password: 'secretPwd123' });
  console.log('signup result', s);
})();
```

**Mapping to the web client flows**
- The web app currently uses `loginWithEmail`, `registerWithEmail`, `sendSignInLink`, `completeSignInWithEmailLink`, and phone/Google client flows from `packages/firebase-clients`.
- You can switch `loginWithEmail` in the web app to call `POST /api/v1/auth/login` to centralize credential handling on the server (server returns `idToken`).
- Magic link flow can be triggered via `/magic-link` server endpoint (which checks Firestore users) or kept client-side.

**Security & operational notes**
- Keep `FIREBASE_PRIVATE_KEY`, `FIREBASE_CLIENT_EMAIL`, and `FIREBASE_PROJECT_ID` secret. Use environment variables or a secrets manager in production.
- Rate-limit and add abuse protection for `/login` and `/magic-link` endpoints.
- Consider using the Firebase Emulator Suite for local testing of Auth + Firestore without touching production data.
