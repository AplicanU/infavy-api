const express = require('express');
const router = express.Router();
const initFirebaseAdmin = require('../../lib/firebaseAdmin');
const { getBlockedChannelIds } = require('../../lib/blockedChannels');

/**
 * @openapi
 * /api/v1/home/grid:
 *   get:
 *     summary: Home grid categories and videos
 */
// GET /api/v1/home/grid
// Returns home grid categories and their videos (ordered per homeGridItems)
router.get('/', async (req, res) => {
  const adm = initFirebaseAdmin();
  if (!adm) return res.status(500).json({ error: 'Firebase Admin not initialized on server' });

  try {
    const db = adm.firestore();

    // Load categories
    const catSnap = await db.collection('homeGridCategories').get();
    const categories = catSnap.docs
      .map((d) => ({ key: d.id, ...(d.data() || {}) }))
      .filter((c) => c.isActive !== false)
      .map((c) => ({ key: c.key || c.key, label: c.label || c.key, order: c.order ?? 0, gridType: c.gridType || 'video' }));

    // sort categories by order
    categories.sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0));

    // Preload channels once
    const channelsSnap = await db.collection('channels').get();
    const channels = channelsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

    const uid = typeof req.query.uid === 'string' && req.query.uid.trim() !== '' ? req.query.uid.trim() : (typeof req.query.userId === 'string' && req.query.userId.trim() !== '' ? req.query.userId.trim() : undefined);

    // For each category, fetch homeGridItems and resolve videos
    const results = [];
    for (const cat of categories) {
      const itemsSnap = await db.collection('homeGridItems').where('category', '==', cat.key).get();
      const homeItems = itemsSnap.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }));

      // Collect referenced ids (either videoId or videoIds)
      const videoIdList = [];
      homeItems.forEach((it) => {
        if (Array.isArray(it.videoIds)) it.videoIds.forEach((v) => videoIdList.push(String(v)));
        else if (it.videoId) videoIdList.push(String(it.videoId));
      });

      const uniqueIds = Array.from(new Set(videoIdList)).filter(Boolean);

      let resolvedVideos = [];
      if (uniqueIds.length > 0) {
        // Fetch by document ID first (FieldPath.documentId()) then fallback to videoId field
        const FieldPath = adm.firestore.FieldPath;
        const chunkSize = 10;
        const videoDocsMap = new Map();

        // fetch by document id
        for (let i = 0; i < uniqueIds.length; i += chunkSize) {
          const chunk = uniqueIds.slice(i, i + chunkSize);
          const q = db.collection('videos').where(FieldPath.documentId(), 'in', chunk);
          const snap = await q.get();
          snap.docs.forEach((d) => videoDocsMap.set(d.id, { id: d.id, ...d.data() }));
        }

        // find missing ids (not matched by doc id)
        const missing = uniqueIds.filter((id) => !videoDocsMap.has(id));
        if (missing.length > 0) {
          // fetch by videoId field
          for (let i = 0; i < missing.length; i += chunkSize) {
            const chunk = missing.slice(i, i + chunkSize);
            const q = db.collection('videos').where('videoId', 'in', chunk);
            const snap = await q.get();
            snap.docs.forEach((d) => {
              const data = d.data();
              // prefer key by document id to avoid collisions
              videoDocsMap.set(d.id, { id: d.id, ...data });
            });
          }
        }


        const videoDocs = Array.from(videoDocsMap.values());

        // Map channels to videos and normalize fields similar to frontend
        resolvedVideos = videoDocs.map((v) => {
          const channelOwner = channels.find((c) => c.owner === v.creatorId) || channels.find((c) => c.id === v.channelId);
          const playbackId = v.muxPlaybackId || v.playbackId || (v.mux && (v.mux.playback_ids?.[0]?.id || v.mux.playbackId)) || null;
          const posterUrl = v.verticalThumbnailURL || (playbackId ? `https://image.mux.com/${playbackId}/thumbnail.jpg` : '/dummy-profile.png');

          return {
            id: v.id,
            videoId: v.videoId || null,
            title: v.title || (v.meta && v.meta.title) || 'Untitled',
            description: v.shortDescription || '',
            playbackId,
            posterUrl,
            thumbnail: v.horizontalThumbnailURL || posterUrl,
            author: channelOwner?.name || 'Unknown Creator',
            channelLogo: channelOwner?.logoURL || channelOwner?.bannerURL || '/dummy-profile.png',
            views: v.views || 0,
            raw: v,
          };
        });

        // apply blocked channels filtering if uid present
        if (uid && resolvedVideos.length) {
          const blocked = await getBlockedChannelIds(db, uid);
          if (blocked.size) {
            resolvedVideos = resolvedVideos.filter((rv) => {
              const ch = rv.raw && rv.raw.channelId ? String(rv.raw.channelId) : null;
              return !(ch && blocked.has(ch));
            });
          }
        }

        // Apply ordering based on homeItems
        const orderMap = new Map();
        homeItems.forEach((item, idx) => {
          const orderValue = typeof item.order === 'number' ? item.order : idx;
          if (Array.isArray(item.videoIds)) item.videoIds.forEach((vid) => orderMap.set(String(vid), orderValue));
          else if (item.videoId) orderMap.set(String(item.videoId), orderValue);
          else if (item.videoIdDoc) orderMap.set(String(item.videoIdDoc), orderValue);
        });

        const MAX = Number.MAX_SAFE_INTEGER;
        resolvedVideos.sort((a, b) => (orderMap.get(a.id) ?? orderMap.get(a.videoId) ?? MAX) - (orderMap.get(b.id) ?? orderMap.get(b.videoId) ?? MAX));
      }

      results.push({ key: cat.key, label: cat.label, gridType: cat.gridType, order: cat.order, videos: resolvedVideos });
    }

    return res.json({ ok: true, categories: results });
  } catch (err) {
    console.error('Error in /api/v1/home/grid:', err);
    return res.status(500).json({ error: 'Failed to fetch home grid data', details: err.message || err });
  }
});

module.exports = router;
