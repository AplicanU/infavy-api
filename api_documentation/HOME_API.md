# Homepage / Hero API

## Overview

This endpoint provides the data used by the website homepage hero component (top featured item list). It aggregates the `featuredVideos` collection and joins each featured item with its corresponding video document from `videos` and author information from `channels`.

## Endpoint

- Method: `GET`
- URL: `/api/v1/home/hero`

## Response

Success response (HTTP 200):

```
{
  "ok": true,
  "items": [
    {
      "id": "GDiS7p4jG6jt0Vo63sNn",
      "title": "Golden Hour Bliss",
      "channelId": "4lTzVHft9dRAIYRlamgc",
      "creatorId": "aLKWT1wDskY3wjwdh9DEAIAoKtP2",
      "muxUploadId": "lzNKvBmXtEuncYVEoGKpTikatlIMlqgV9VMObiYimiw",
      "views": 0,
      "createdAt": {
        "_seconds": 1761545037,
        "_nanoseconds": 51000000
      },
      "videoId": "GDiS7p4jG6jt0Vo63sNn",
      "longDescription": "Immerse yourself in the tranquil beauty of a beach sunset, where golden hues meet gentle waves, and the stresses of life melt away in the serene coastal atmosphere.",
      "uploadDate": "2025-10-27T00:32:00.000Z",
      "shortDescription": "Breathtaking sunset beach vibes and soothing ocean waves.",
      "categories": [
        "Travel"
      ],
      "fullDescription": "",
      "type": "Short",
      "tags": [
        "BeachSunset",
        "GoldenHour",
        "OceanViews",
        "CoastalRelaxation",
        "SunsetVibes"
      ],
      "horizontalThumbnailURL": "https://firebasestorage.googleapis.com/v0/b/mvp-infavy.firebasestorage.app/o/VideoData%2FaLKWT1wDskY3wjwdh9DEAIAoKtP2%2FlzNKvBmXtEuncYVEoGKpTikatlIMlqgV9VMObiYimiw%2Fhorizontal.png?alt=media&token=700daed1-1d5d-4a27-986d-37c78059d66b",
      "verticalThumbnailURL": "https://firebasestorage.googleapis.com/v0/b/mvp-infavy.firebasestorage.app/o/VideoData%2FaLKWT1wDskY3wjwdh9DEAIAoKtP2%2FlzNKvBmXtEuncYVEoGKpTikatlIMlqgV9VMObiYimiw%2Fvertical.png?alt=media&token=131aa99b-b17e-45f6-b8a2-abebb2e1e3c9",
      "updatedAt": {
        "_seconds": 1761545504,
        "_nanoseconds": 717000000
      },
      "muxPlaybackId": "kU1fZT4EAJYxKePzUSE6YaGe800JFTY00bAzkzfkKDOYo",
      "status": "Published",
      "author": "Terraverde",
      "order": 1
    },
  ]
}
```

If there are no active featured documents the API returns:

```
{ "ok": true, "items": [] }
```

On error the API returns HTTP 4xx/5xx with a JSON body, for example:

```
{ "error": "Failed to fetch homepage hero data", "details": "..." }
```

## Behavior and Notes

- The endpoint reads `featuredVideos` and selects documents where `isActive == true`.
- Featured items are sorted by the `order` field (missing `order` treated as 0).
- For each featured item we look up the video in the `videos` collection by the `videoId` field.
- If multiple `videoId` values are needed in a single query, the server performs chunked `where('videoId', 'in', [...])` queries (Firestore `in` supports up to 10 values per query).
- The endpoint also loads all `channels` and attempts to derive the author name by matching `channels.owner === videos.creatorId` or `channels.id === videos.channelId`.

## Required Firestore Collections & Fields

- `featuredVideos` documents should contain at least:
  - `videoId` (string)
  - `isActive` (boolean)
  - `order` (number, optional)

- `videos` documents should contain at least:
  - `videoId` (string) — unique identifier used across featured documents
  - metadata fields required by the frontend (title, playback ids, thumbnails, descriptions, etc.)

- `channels` documents should contain at least:
  - `id` (document id)
  - `owner` (uid string) or other fields to link the channel to the video's creator
  - `name` (string)

## Server-side Environment Variables

The API uses Firebase Admin SDK to access Firestore. Provide the following env vars for server-side Firebase Admin initialization:

- `FIREBASE_PROJECT_ID` (or `NEXT_PUBLIC_FIREBASE_PROJECT_ID`)
- `FIREBASE_CLIENT_EMAIL`
- `FIREBASE_PRIVATE_KEY` (newline characters should be escaped as `\n` when stored in environment variables; the server converts these to actual newlines)

If Admin credentials are missing, the route will return an error indicating Firebase Admin is not initialized.

## Example (PowerShell)

```powershell
# Ensure api-server is running, then:
Invoke-RestMethod -Uri 'http://localhost:4000/api/v1/home/hero' -Method GET | ConvertTo-Json -Depth 5
```

## Frontend integration

The endpoint returns an ordered array that the frontend `Hero` component can map to a carousel/tiles. The frontend may expect specific fields (playback ids, thumbnail URLs, descriptions); ensure those fields exist on your `videos` documents.

---

## Home Grid API

This endpoint provides the data for the homepage grid sections (the various carousels/grids shown on the home page). It aggregates `homeGridCategories`, `homeGridItems`, and joins them with `videos` and `channels` collection data.

### Endpoint

- Method: `GET`
- URL: `/api/v1/home/grid`

### Response

Success response (HTTP 200):

```
{
  "ok": true,
  "categories": [
    {
      "key": "recommended",
      "label": "Recommended for you",
      "gridType": "video",
      "order": 0,
      "videos": [
        {
          "id": "<firestore-doc-id>",
          "videoId": "<video-id>",
          "title": "...",
          "playbackId": "...",
          "posterUrl": "...",
          "thumbnail": "...",
          "author": "Creator Name",
          "views": 123,
          "raw": { /* original Firestore video doc */ }
        }
      ]
    }
  ]
}
```

If there are no categories or no items the API returns `{"ok": true, "categories": []}`.

### Behavior and Notes

- Loads `homeGridCategories` and returns only categories where `isActive` is not `false`.
- For each category, loads `homeGridItems` (documents that reference either `videoId` or `videoIds` arrays).
- The implementation attempts to resolve referenced videos first by document ID (Firestore document id) and then by the `videoId` field if not found.
- Firestore `in` queries are chunked to a maximum of 10 values per query to avoid Firestore limits.
- Channels are preloaded to derive author names by matching `channels.owner === videos.creatorId` or `channels.id === videos.channelId`.
- Videos returned include normalized fields expected by the frontend (`playbackId`, `posterUrl`, `thumbnail`, `author`, `views`) as well as the original document under `raw`.

### Required Firestore Collections & Fields

- `homeGridCategories` documents should contain at least:
  - `label` (string)
  - `gridType` (e.g. `video` or `image`)
  - `order` (number, optional)
  - `isActive` (boolean, optional)

- `homeGridItems` documents should reference category keys and include either:
  - `videoId` (string) OR
  - `videoIds` (array of strings)
  - `order` (number, optional)

- `videos` documents should contain the metadata expected by the frontend (playback ids, thumbnails, titles, descriptions, etc.).

- `channels` documents should contain `name`, and either `owner` or a matching channel id used by `videos` documents.

### Example (PowerShell)

```powershell
Invoke-RestMethod -Uri 'http://localhost:4000/api/v1/home/grid' -Method GET | ConvertTo-Json -Depth 6
```

### Frontend integration

The frontend `HomeVideoGrid` component fetches categories and then resolves each category's videos; the API mirrors the structure the component expects and simplifies client-side lookups by doing joins server-side.

