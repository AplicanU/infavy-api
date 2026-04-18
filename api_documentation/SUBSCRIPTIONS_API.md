# Subscriptions API

This document describes the server-side Subscribe/Unsubscribe API for channel subscriptions.

Base path: `/api/v1/subscriptions`

## POST /subscribe
- Description: Create a channel subscription for a user/profile. If a matching subscription already exists the endpoint updates `createdAt` and returns `duplicate: true`.
- Method: `POST`
- Body (JSON):
  - `userId` (string, required) — explicit user id to act on. This endpoint requires `userId` in the request body.
  - `profileId` (string|null, optional) — profile id associated with the subscription; use `null` to store no profile. If omitted, the server treats profile as `null` when creating.
  - `channelId` (string, required) — id of the channel to subscribe to.
- Authorization: explicit `userId` required; `Authorization` header is not used.
- Success Responses:
  - New subscription created: `201` `{ ok: true, item: { id, userId, profileId, channelId, createdAt } }`
  - Already subscribed: `200` `{ ok: true, duplicate: true }`

## POST /unsubscribe
- Description: Remove one or more channel subscriptions matching the provided `userId`, `channelId`, and optional `profileId`.
- Method: `POST`
- Body (JSON):
  - `userId` (string, required) — explicit user id to act on. This endpoint requires `userId` in the request body.
  - `profileId` (string|null, optional) — profile id to target for deletion; when omitted it will match documents where `profileId` equals the provided value (or `null` if set to `null`).
  - `channelId` (string, required) — id of the channel to unsubscribe from.
- Authorization: explicit `userId` required; `Authorization` header is not used.
- Success Responses:
  - Nothing deleted (no matching doc): `200` `{ ok: true, deleted: false }`
  - Deleted items: `200` `{ ok: true, deleted: true }`

## GET /list
- Description: Return a list of channel subscriptions for a user and optional profile. Returns subscription documents (id + fields) matching the provided `userId` and optional `profileId`.
- Method: `GET`
- Query parameters:
  - `userId` (string, required) — explicit user id to act on. This endpoint requires `userId` in the query string.
  - `profileId` (string|null, optional) — profile id associated with the subscription; use the literal string `null` to indicate no-profile subscriptions. If omitted, the server will not filter by profile.
- Authorization: explicit `userId` required; `Authorization` header is not used.
- Success Response:
  - `200` `{ ok: true, items: [ { id, userId, profileId, channelId, createdAt }, ... ] }`


## Behavior / Notes
- The endpoints require an explicit `userId` in the request (body). Bearer token authorization is not used.
- Subscriptions are stored in the `channelSubscriptions` Firestore collection and the channel's `subscriberCount` is incremented/decremented using Firestore server-side increments (`FieldValue.increment`).
- `profileId` handling: the literal string `null` is treated as `null` to target no-profile subscriptions; omitting `profileId` means the request did not specify a profile filter.

## Examples

Subscribe (explicit userId):

```
POST /api/v1/subscriptions/subscribe
Content-Type: application/json

{ "userId": "UID123", "profileId": null, "channelId": "CHAN123" }
```

Unsubscribe (explicit userId):

```
POST /api/v1/subscriptions/unsubscribe
Content-Type: application/json

{ "userId": "UID123", "profileId": null, "channelId": "CHAN123" }
```

File: src/routes/subscriptions.js
