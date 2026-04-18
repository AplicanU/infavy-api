const express = require('express');
const initFirebaseAdmin = require('../lib/firebaseAdmin');
const { getBlockedChannelIds } = require('../lib/blockedChannels');

const router = express.Router();

// GET / - list published videos with pagination and total count
// Query params:
// - page (1-based, default 1)
// - perPage (default 20, max 100)
router.get('/', async (req, res) => {
  try {
    const admin = initFirebaseAdmin();
    if (!admin) return res.status(500).json({ error: 'Firebase Admin not configured' });

    const db = admin.firestore();

    // Filter published videos. The project uses the `status` field with value 'Published'.
    const statusField = 'status';
    const publishedValue = 'Published';

    // accept optional uid to filter out videos from blocked channels
    const uid = typeof req.query.uid === 'string' && req.query.uid.trim() !== '' ? req.query.uid.trim() : (typeof req.query.userId === 'string' && req.query.userId.trim() !== '' ? req.query.userId.trim() : undefined);

    // Fetch all published videos (no pagination for now)
    let videosSnap;
    try {
      videosSnap = await db.collection('videos').where(statusField, '==', publishedValue).get();
    } catch (err) {
      console.error('[videos] failed to fetch published videos', err);
      return res.status(500).json({ error: 'Failed to fetch published videos', detail: err.message || err });
    }

    // Load blocked channels for uid (if provided) and exclude those videos
    const blockedSet = uid ? await getBlockedChannelIds(db, uid) : new Set();

    const videos = [];
    const channelIds = new Set();
    videosSnap.forEach((doc) => {
      const d = doc.data() || {};
      const channelId = d.channelId ? String(d.channelId) : null;
      if (channelId && blockedSet.has(channelId)) return; // skip blocked channel videos
      const docObj = { id: doc.id, ...d };
      videos.push(docObj);
      if (docObj.channelId) channelIds.add(String(docObj.channelId));
    });

    // Build channelId -> metadata map in batches (Firestore 'in' supports up to 10 values)
    const channelMap = {};
    try {
      const ids = Array.from(channelIds);
      const BATCH = 10;
      for (let i = 0; i < ids.length; i += BATCH) {
        const batch = ids.slice(i, i + BATCH);
        const snap = await db.collection('channels').where(admin.firestore.FieldPath.documentId(), 'in', batch).get();
        snap.forEach((c) => {
          const data = c.data() || {};
          channelMap[c.id] = {
            name: data.name || null,
            logoURL: data.logoURL || data.thumbnail || data.logo || null,
            bannerURL: data.bannerURL || null,
          };
        });
      }
    } catch (chErr) {
      console.warn('[videos] failed to fetch channel metadata, continuing without channel names', chErr.message || chErr);
    }

    // Enrich videos with `author` (channel name) and `channelLogo` following existing project fallback logic
    const enriched = videos.map((v) => {
      const playbackId = v.muxPlaybackId || v.playbackId || (v.mux && (v.mux.playback_ids?.[0]?.id || v.mux.playbackId)) || null;
      const thumbnail = v.horizontalThumbnailURL || v.thumbnail || v.thumbnailURL || (playbackId ? `https://image.mux.com/${playbackId}/thumbnail.jpg` : null) || null;
      const channel = channelMap[String(v.channelId)] || {};
      return {
        ...v,
        playbackId,
        thumbnail,
        author: channel.name || v.channelName || v.creatorId || v.channelId || null,
        channelLogo: channel.logoURL || channel.bannerURL || v.logoURL || null,
      };
    });

    return res.json({ ok: true, count: enriched.length, videos: enriched });
  } catch (err) {
    console.error('[videos] failed to fetch published videos', err);
    return res.status(500).json({ error: 'Failed to fetch published videos' });
  }
});

// POST /report - save reported content
// Body: { uid, videoId, channelId, reportedCategory, userMessage }
router.post('/report', async (req, res) => {
  try {
    const { uid, videoId, channelId, reportedCategory, userMessage } = req.body || {};

    if (!uid || !videoId || !channelId || !reportedCategory) {
      return res.status(400).json({ error: 'Missing required fields: uid, videoId, channelId, reportedCategory' });
    }

    const admin = initFirebaseAdmin();
    if (!admin) return res.status(500).json({ error: 'Firebase Admin not configured' });

    const db = admin.firestore();

    const payload = {
      uid: String(uid),
      videoId: String(videoId),
      channelId: String(channelId),
      reportedCategory: String(reportedCategory),
      userMessage: userMessage ? String(userMessage) : null,
      createdAt: admin.firestore.Timestamp.now(),
    };

    const ref = await db.collection('reportedContent').add(payload);

    return res.json({ ok: true, id: ref.id });
  } catch (err) {
    console.error('[videos][report] failed to save reported content', err);
    return res.status(500).json({ error: 'Failed to save reported content' });
  }
});

module.exports = router;
