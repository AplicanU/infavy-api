# Watchlist API

This document describes the Watchlist API endpoints used by the web client to load, add, and remove videos from a user's watchlist.

Base path: `/api/v1/watchlist`

## GET /list
- Description: Returns a user's watchlist items (optionally filtered by profile). This implementation REQUIRES an explicit `userId` query parameter.
- Method: `GET`
- Query Parameters:
  - `userId` (string, required) — explicit user id to fetch the watchlist for. The endpoint returns `400` when this parameter is missing.
  - `profileId` (string|null, optional) — when provided as `null` (literal string `null`) the endpoint returns items where `profileId` is null/undefined; otherwise filters to the given profile id. If omitted, returns all profiles for the user.
- Success Response: `{ ok: true, items: [ { id, userId, profileId, videoId, createdAt }, ... ] }`

## POST /add
- Description: Add a video to a user's watchlist. If an identical watchlist item already exists (same `userId`, `videoId`, and `profileId` when provided) the item's `createdAt` timestamp is updated (client expects `duplicate: true`).
- Method: `POST`
- Body (JSON):
  - `userId` (string, required) — explicit user id to modify. This endpoint requires `userId` in the request body.
  - `profileId` (string|null, optional) — profile id associated with the watchlist item; use `null` to store no profile. If omitted, the server treats profile as `null` when creating.
  - `videoId` (string, required) — id of the video to add.
- Success Responses:
  - New item created: `201` `{ ok: true, item: { id, userId, profileId, videoId, createdAt } }`
  - Item existed: `200` `{ ok: true, duplicate: true }` (timestamp updated)

## POST /remove
- Description: Remove a video from a user's watchlist. Deletes any matching watchlist documents for the combination of `userId`, `videoId`, and optional `profileId`.
- Method: `POST`
- Body (JSON):
  - `userId` (string, required) — explicit user id to modify. This endpoint requires `userId` in the request body.
  - `profileId` (string|null, optional) — profile id to target for deletion; when omitted it will match documents where `profileId` equals the provided value (or `null` if set to `null`).
  - `videoId` (string, required) — id of the video to remove.
- Success Responses:
  - Nothing deleted (no matching doc): `200` `{ ok: true, deleted: false }`
  - Deleted items: `200` `{ ok: true, deleted: true }`

-## Notes / Behavior details
The current implementation requires callers to provide an explicit `userId` parameter for all watchlist endpoints (query for GET, body for POST).
- `profileId` handling: the code treats the string literal `null` as a request for null profile; otherwise `undefined` means "not provided".
- Timestamps: `createdAt` is set using Firestore server timestamp. When adding an already-existing item, the endpoint updates `createdAt` so the item appears as most-recent.

## Examples

Add (using explicit userId):

```
POST /api/v1/watchlist/add
Content-Type: application/json

{ "userId": "UID123", "profileId": null, "videoId": "VID123" }
```

Remove (using explicit userId):

```
POST /api/v1/watchlist/remove
Content-Type: application/json

{ "userId": "UID123", "profileId": null, "videoId": "VID123" }
```

List (using explicit userId):

```
GET /api/v1/watchlist/list?userId=UID123
```

List (for a profile using explicit userId):

```
GET /api/v1/watchlist/list?userId=UID123&profileId=PROFILE456
```

----

File: src/routes/watchlist.js
