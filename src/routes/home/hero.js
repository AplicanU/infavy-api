const express = require('express');
const router = express.Router();
const initFirebaseAdmin = require('../../lib/firebaseAdmin');
const { getBlockedChannelIds } = require('../../lib/blockedChannels');

/**
 * @openapi
 * /api/v1/home/hero:
 *   get:
 *     summary: Homepage hero featured videos
 */
// GET /api/v1/home/hero
// Returns an ordered list of featured videos with joined video and channel metadata
router.get('/', async (req, res) => {
  const adm = initFirebaseAdmin();
  if (!adm) return res.status(500).json({ error: 'Firebase Admin not initialized on server' });

  try {
    const db = adm.firestore();

    // 1) featured documents
    const featuredSnap = await db.collection('featuredVideos').where('isActive', '==', true).get();
    if (featuredSnap.empty) return res.json({ ok: true, items: [] });

    const featuredDocs = featuredSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    featuredDocs.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const featuredIds = featuredDocs.map((d) => d.videoId).filter(Boolean);

    const uid = typeof req.query.uid === 'string' && req.query.uid.trim() !== '' ? req.query.uid.trim() : (typeof req.query.userId === 'string' && req.query.userId.trim() !== '' ? req.query.userId.trim() : undefined);

    let videosData = [];
    if (featuredIds.length > 0) {
      // Firestore 'in' supports up to 10 values — chunk if needed
      const chunks = [];
      for (let i = 0; i < featuredIds.length; i += 10) chunks.push(featuredIds.slice(i, i + 10));

      let videosDocs = [];
      for (const chunk of chunks) {
        const q = db.collection('videos').where('videoId', 'in', chunk);
        const snap = await q.get();
        videosDocs = videosDocs.concat(snap.docs);
      }

      const channelsSnap = await db.collection('channels').get();
      const channels = channelsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

      const videosMap = new Map(videosDocs.map((d) => {
        const data = d.data();
        return [data.videoId, { id: d.id, ...data }];
      }));

      const featuredInfoMap = new Map(featuredDocs.map((f) => [f.videoId, f]));

      videosData = featuredIds
        .map((vid) => {
          const data = videosMap.get(vid);
          if (!data) return null; // featured references a missing video

          const channelOwner =
            channels.find((c) => c.owner === data.creatorId) ||
            channels.find((c) => c.id === data.channelId);

          return {
            ...data,
            author: channelOwner?.name || 'Unknown Creator',
            order: featuredInfoMap.get(vid)?.order ?? null,
          };
        })
        .filter(Boolean);

      // filter out blocked channels for uid
      if (uid && videosData.length) {
        const blocked = await getBlockedChannelIds(db, uid);
        if (blocked.size) videosData = videosData.filter((vd) => !(vd.channelId && blocked.has(String(vd.channelId))));
      }
    }

    return res.json({ ok: true, items: videosData });
  } catch (err) {
    console.error('Error in /api/v1/home/hero:', err);
    return res.status(500).json({ error: 'Failed to fetch homepage hero data', details: err.message || err });
  }
});

module.exports = router;
