# Channels API

**Location**: `src/routes/channels.js`

**Base Path**: `/api/v1/channels`

Overview
- Provides basic CRUD operations for the `channels` Firestore collection used by the website and API.
- Handlers are minimal and intended for internal/admin usage. Add authentication/ACL before exposing in production.

Endpoints
- `GET /api/v1/channels`
  - Description: List all channel documents.
  - Response: 200
    ```json
    { "ok": true, "channels": [ { "id": "docId", "name": "...", "owner": "..." } ] }
    ```

- `GET /api/v1/channels/:id`
  - Description: Return a single channel by Firestore document id.
  - Response: 200
    ```json
    { "ok": true, "channel": { "id": "docId", "name": "..." } }
    ```
  - Errors: 404 when not found, 500 on server error.

- `POST /api/v1/channels`
  - Description: Create a new channel document.
  - Required body: JSON with at least `name`.
  - Minimal example body:
    ```json
    { "name": "My Channel", "shortDescription": "Quick desc", "isVerified": true }
    ```
  - Success: 201
    ```json
    { "ok": true, "channel": { "id": "newDocId", "name": "My Channel", "createdAt": 163... } }
    ```
  - Validation: returns 400 if `name` is missing.

- `PUT /api/v1/channels/:id`
  - Description: Update an existing channel (partial updates allowed).
  - Example body:
    ```json
    { "shortDescription": "Updated description" }
    ```
  - Success: 200
    ```json
    { "ok": true, "channel": { "id": "docId", "shortDescription": "Updated description", "updatedAt": 163... } }
    ```
  - Errors: 404 when channel not found.

- `DELETE /api/v1/channels/:id`
  - Description: Delete the channel document by id.
  - Success: 200
    ```json
    { "ok": true, "id": "docId" }
    ```

Channel object fields (used/created by API)
- `id` (string) — Firestore document id (returned only in responses)
- `name` (string)
- `owner` (string | null) — optional owner id
- `bannerURL` (string | null)
- `shortDescription` (string | null)
- `isVerified` (boolean)
- `createdAt` (number) — epoch ms
- `updatedAt` (number) — epoch ms
- `extraFields` — on creation any `extraFields` will be shallow-merged into document

Authentication & Environment
- The server uses the Firebase Admin SDK via `initFirebaseAdmin()` in `src/lib/firebaseAdmin.js`.
- Required environment variables to initialize Admin SDK:
  - `FIREBASE_PROJECT_ID`
  - `FIREBASE_CLIENT_EMAIL`
  - `FIREBASE_PRIVATE_KEY` (must have literal newlines escaped `\n` in env)
- This routes file does NOT implement authentication. Protect these endpoints with JWT/session middleware or network-level controls for production.

Examples (curl / PowerShell)
- List channels (curl):
  ```bash
  curl -sS http://localhost:3000/api/v1/channels
  ```
- Create channel (curl):
  ```bash
  curl -sS -X POST http://localhost:3000/api/v1/channels \
    -H "Content-Type: application/json" \
    -d '{"name":"My Channel","shortDescription":"Test"}'
  ```
- Create channel (PowerShell):
  ```powershell
  $body = @{ name='My Channel'; shortDescription='Test' } | ConvertTo-Json
  Invoke-RestMethod -Method POST -Uri 'http://localhost:3000/api/v1/channels' -Body $body -ContentType 'application/json'
  ```

Errors
- 400 Bad Request — validation failure (missing `name` on create)
- 404 Not Found — requested channel does not exist
- 500 Internal Server Error — Firebase Admin not initialized or Firestore errors

Notes & Recommendations
- Consider adding request validation (e.g., `ajv`) and standardized response shapes.
- Add authentication/authorization for create/update/delete operations.
- If the frontend expects timestamps as Firestore Timestamp objects, update serialization accordingly. Current implementation stores epoch milliseconds in `createdAt`/`updatedAt`.

Change log
- Created: Documented endpoints for `channels` router.
