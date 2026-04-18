# Videos API

## GET /api/v1/videos

Returns a paginated list of published videos and the total number of published videos.

Query Parameters:
- `page` (integer, optional) — 1-based page number. Default: 1
- `perPage` (integer, optional) — items per page. Default: 20, max: 100

Response (200):

{
  "ok": true,
  "count": 123,       // total published videos (may be null if counting failed)
  "page": 1,
  "perPage": 20,
  "videos": [
    {
      "id": "VIDEO_DOC_ID",
      "title": "...",
      "channelId": "...",
      "status": "Published",
      "publishedAt": "2024-12-01T12:00:00.000Z",
      // other video fields as stored in Firestore
    }
  ]
}

Notes:
- The endpoint filters by `status == 'Published'`.
- For large collections Firestore may require a composite index for the combination of `where(status == 'Published')` and `orderBy(publishedAt, 'desc')`. If you see an index error, create the index in Firebase Console or add a `firestore.indexes.json` and deploy via `firebase deploy --only firestore:indexes`.
- If an index is missing the server will attempt an unindexed fallback (inefficient) and return a `warning` property in the response.
