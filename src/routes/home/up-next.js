const express = require('express');
const router = express.Router();
const initFirebaseAdmin = require('../../lib/firebaseAdmin');
const { getBlockedChannelIds } = require('../../lib/blockedChannels');

// GET /api/v1/home/next
// Query params:
// - playbackId or videoId : identify the current video to exclude
// - channelId (optional)  : prefer suggestions from same channel
// - recentlyPlayed (opt)  : comma-separated videoIds to exclude
router.get('/', async (req, res) => {
  const adm = initFirebaseAdmin();
  if (!adm) return res.status(500).json({ error: 'Firebase Admin not initialized on server' });

  try {
    const db = adm.firestore();

    const { channelId } = req.query;
    const uid = typeof req.query.uid === 'string' && req.query.uid.trim() !== '' ? req.query.uid.trim() : (typeof req.query.userId === 'string' && req.query.userId.trim() !== '' ? req.query.userId.trim() : undefined);
    const currentVideoId = req.query.videoId || req.query.playbackId || null;
    const recentlyRaw = req.query.recentlyPlayed || '';
    const recentlyPlayed = recentlyRaw ? recentlyRaw.split(',').map((s) => String(s).trim()).filter(Boolean) : [];

    let q;
    const col = db.collection('videos');
    if (channelId) {
      q = col
        .where('channelId', '==', String(channelId))
        .where('status', '==', 'Published')
        .limit(8);
    } else {
      q = col
        .where('status', '==', 'Published')
        .orderBy('uploadDate', 'desc')
        .limit(8);
    }

    const snap = await q.get();
    const items = [];
    snap.forEach((docSnap) => {
      const data = docSnap.data();
      const docKey = data && (data.videoId || data.playbackId || data.muxPlaybackId) ? (data.videoId || data.playbackId || data.muxPlaybackId) : null;
      if (data && docKey && docKey !== currentVideoId) {
        items.push({ id: docSnap.id, ...data });
      }
    });

    // Load channels map to resolve creator names
    let channelMap = {};
    try {
      const chSnap = await db.collection('channels').get();
      chSnap.forEach((c) => {
        const d = c.data();
        channelMap[c.id] = d?.name || d?.owner || null;
      });
    } catch (e) {
      // ignore
    }

    // Build normalized items and apply thumbnails
    const normalized = items.map((it) => {
      const playback = it.muxPlaybackId || it.videoId || it.playbackId || null;
      const thumbnail = it.horizontalThumbnailURL || it.thumbnailURL || (playback ? `https://image.mux.com/${playback}/thumbnail.jpg` : null);
      return {
        id: it.id,
        videoId: it.videoId || null,
        title: it.title || it.shortDescription || 'Untitled',
        playbackId: playback,
        thumbnail,
        creatorName: it.creatorName || channelMap[it.channelId] || it.creatorId || it.channelId || 'Unknown',
        channelId: it.channelId || null,
      };
    });

    // Filter out recently played if provided
    let filtered = normalized.filter((it) => !(it.videoId && recentlyPlayed.includes(it.videoId)));

    // apply blocked channels filter if uid provided
    if (uid) {
      const blocked = await getBlockedChannelIds(db, uid);
      filtered = filtered.filter((it) => !(it.channelId && blocked.has(String(it.channelId))));
    }

    // simple shuffle
    const shuffle = (arr) => {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = arr[i];
        arr[i] = arr[j];
        arr[j] = tmp;
      }
      return arr;
    };

    // Prefer filtered (related) items; if none, fall back to any published videos
    let poolCandidates = filtered.length ? filtered.slice() : [];

    if (poolCandidates.length === 0) {
      try {
        const fallbackQ = col.where('status', '==', 'Published').limit(32);
        const fallbackSnap = await fallbackQ.get();
        const fallbackItems = [];
        fallbackSnap.forEach((docSnap) => {
          const data = docSnap.data();
          const docKey = data && (data.videoId || data.playbackId || data.muxPlaybackId) ? (data.videoId || data.playbackId || data.muxPlaybackId) : null;
          if (data && docKey && docKey !== currentVideoId) {
            fallbackItems.push({ id: docSnap.id, ...data });
          }
        });

        const fallbackNormalized = fallbackItems.map((it) => {
          const playback = it.muxPlaybackId || it.videoId || it.playbackId || null;
          const thumbnail = it.horizontalThumbnailURL || it.thumbnailURL || (playback ? `https://image.mux.com/${playback}/thumbnail.jpg` : null);
          return {
            id: it.id,
            videoId: it.videoId || null,
            title: it.title || it.shortDescription || 'Untitled',
            playbackId: playback,
            thumbnail,
            creatorName: it.creatorName || channelMap[it.channelId] || it.creatorId || it.channelId || 'Unknown',
            channelId: it.channelId || null,
          };
        });

        poolCandidates = fallbackNormalized.filter((it) => !(it.videoId && recentlyPlayed.includes(it.videoId)));
      } catch (e) {
        // ignore fallback errors and continue with whatever we have
      }
    }

    // Last-resort: use the original normalized list (already from initial query)
    if (poolCandidates.length === 0) {
      poolCandidates = normalized.slice().filter((it) => !(it.videoId && recentlyPlayed.includes(it.videoId)));
    }

    const pool = shuffle(poolCandidates);

    const chosen = pool.length > 0 ? pool[0] : null;

    return res.json({ ok: true, next: chosen, poolCount: pool.length });
  } catch (err) {
    console.error('Error in /api/v1/home/next:', err);
    return res.status(500).json({ error: 'Failed to fetch next-up suggestion', details: err.message || err });
  }
});

module.exports = router;
