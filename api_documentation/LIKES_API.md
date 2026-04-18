# Likes API

This document describes the endpoints to like and unlike a video. The video's like count is stored in the `videos` collection under the `likes` field.

Base path: `/api/v1/likes`

## POST /like
- Description: Like a video on behalf of a user (creates a per-user like record and increments the video's `likes` counter). If the user already liked the video the endpoint returns `duplicate: true` and does not increment again.
- Method: `POST`
- Body (JSON):
  - `userId` (string, required) — explicit user id to act on. This endpoint requires `userId` in the request body.
  - `profileId` (string|null, optional) — optional profile id associated with the like; use `null` to indicate no profile. If omitted the server treats profile as `null` when recording the like.
  - `videoId` (string, required) — id of the video to like (also used as document id in `videos` collection).
- Authorization: explicit `userId` required; `Authorization` header is not used.
- Success Responses:
  - New like created: `201` `{ ok: true, likes: <new_like_count> }`
  - Already liked: `200` `{ ok: true, duplicate: true }`

## POST /unlike
- Description: Unlike a video on behalf of a user (deletes the per-user like record and decrements the video's `likes` counter). If no like exists for the user the endpoint returns `deleted: false`.
- Method: `POST`
- Body (JSON): same as `/like`.
- Authorization: explicit `userId` required; `Authorization` header is not used.
- Success Responses:
  - Nothing removed: `200` `{ ok: true, deleted: false }`
  - Removed: `200` `{ ok: true, deleted: true, likes: <new_like_count> }`

## GET /list
- Description: Return a user's likes (optionally filtered by `profileId`). This endpoint requires an explicit `userId` query parameter and does NOT accept an `Authorization` bearer token.
- Method: `GET`
- Query Parameters:
  - `userId` (string, required) — explicit user id to fetch likes for. The endpoint will return `400` if not provided.
  - `profileId` (string|null, optional) — when provided as the literal string `null` the endpoint returns items where `profileId` is null/undefined; otherwise filters to the given profile id. If omitted, returns all profiles for the user.
- Authorization: explicit `userId` required; `Authorization` header is not used for this endpoint.
- Success Response: `{ ok: true, items: [ { id, userId, profileId, videoId, createdAt }, ... ] }`

## Notes / Behavior details (likes list)
- Per-user likes are stored in the `videoLikes` collection; the `GET /list` endpoint queries `videoLikes` by `userId` and applies an optional `profileId` filter in-memory to support `null` vs undefined semantics.

## Implementation notes
- Per-user likes are stored in `videoLikes` collection using a deterministic document id composed from `userId`, `videoId`, and `profileId` to make existence checks efficient and to avoid duplicate likes.
- Video like counts are updated inside Firestore transactions to keep the `videos.likes` field consistent and non-negative.
- The endpoints require callers to provide an explicit `userId` (either in the request body for POST endpoints or query for GET /list); bearer token authorization is not used.

## Examples

Like using explicit userId:

```
POST /api/v1/likes/like
Content-Type: application/json

{ "userId": "UID123", "profileId": null, "videoId": "VID123" }
```

Unlike using explicit userId:

```
POST /api/v1/likes/unlike
Content-Type: application/json

{ "userId": "UID123", "profileId": null, "videoId": "VID123" }
```

List likes (explicit userId):

```
GET /api/v1/likes/list?userId=UID123
```

File: src/routes/likes.js
