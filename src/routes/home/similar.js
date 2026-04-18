const express = require('express');
const router = express.Router();
const initFirebaseAdmin = require('../../lib/firebaseAdmin');
const { getBlockedChannelIds } = require('../../lib/blockedChannels');

// GET /api/v1/home/similar
// Query params:
// - excludeVideoId : videoId to exclude from results
// - channelId      : prefer same-channel videos
// - recentlyPlayed : comma-separated videoIds to exclude
// - limit          : number of items (default 12)
router.get('/', async (req, res) => {
  const adm = initFirebaseAdmin();
  if (!adm) return res.status(500).json({ error: 'Firebase Admin not initialized on server' });

  try {
    const db = adm.firestore();
    const { excludeVideoId, channelId } = req.query;
    const limit = Math.min(50, Number(req.query.limit) || 12);
    const recentlyRaw = req.query.recentlyPlayed || '';
    const recentlyPlayed = recentlyRaw ? recentlyRaw.split(',').map((s) => String(s).trim()).filter(Boolean) : [];

    const col = db.collection('videos');
    const uid = typeof req.query.uid === 'string' && req.query.uid.trim() !== '' ? req.query.uid.trim() : (typeof req.query.userId === 'string' && req.query.userId.trim() !== '' ? req.query.userId.trim() : undefined);
    let q;
    // Only fetch videos with Published status
    if (channelId) {
      q = col.where('channelId', '==', String(channelId)).where('status', '==', 'Published').limit(limit);
    } else {
      q = col.where('status', '==', 'Published').orderBy('uploadDate', 'desc').limit(limit);
    }

    const snap = await q.get();
    const items = [];
    snap.forEach((docSnap) => {
      const data = docSnap.data();
      if (!data) return;
      // prefer filtering by videoId where available
      if (data.videoId && data.videoId === excludeVideoId) return;
      if (data.videoId && recentlyPlayed.includes(data.videoId)) return;
      items.push({ id: docSnap.id, ...data });
    });

    // filter out blocked channels for uid (if provided)
    if (uid && items.length) {
      const blocked = await getBlockedChannelIds(db, uid);
      if (blocked.size) {
        for (let i = items.length - 1; i >= 0; i--) {
          const ch = items[i].channelId ? String(items[i].channelId) : null;
          if (ch && blocked.has(ch)) items.splice(i, 1);
        }
      }
    }

    // Try to resolve channel names for display
    const channelMap = {};
    try {
      const chSnap = await db.collection('channels').get();
      chSnap.forEach((c) => {
        const d = c.data() || {};
        channelMap[c.id] = {
          name: d.name || d.owner || null,
          logoURL: d.logoURL || d.thumbnail || d.logo || null,
        };
      });
    } catch (e) {
      // ignore
    }

    const normalized = items.map((it) => {
      const playback = it.muxPlaybackId || it.videoId || it.playbackId || null;
      const thumbnail = it.horizontalThumbnailURL || it.thumbnailURL || (playback ? `https://image.mux.com/${playback}/thumbnail.jpg` : null);
      const channel = it.channelId ? (channelMap[it.channelId] || {}) : {};
      const author = channel.name || null;
      const channelLogo = channel.logoURL || null;
      return {
        it,
        author,
        channelLogo,
      };
    });

    // If channelId provided, sort by uploadDate desc to match client behavior
    if (channelId) {
      normalized.sort((a, b) => {
        const ta = a.uploadDate ? (a.uploadDate.seconds || Date.parse(a.uploadDate)) : 0;
        const tb = b.uploadDate ? (b.uploadDate.seconds || Date.parse(b.uploadDate)) : 0;
        return tb - ta;
      });
    }

    // Fallback: if no similar videos found for the channel, try using
    // categories/tags from the current video (excludeVideoId) to find similar ones.
    if ((!normalized || normalized.length === 0) && excludeVideoId) {
      try {
        // Try to resolve the current video by videoId field first, then by doc id
        let currentVideo = null;
        const byVideoIdSnap = await col.where('videoId', '==', String(excludeVideoId)).limit(1).get();
        if (!byVideoIdSnap.empty) {
          currentVideo = byVideoIdSnap.docs[0].data();
        } else {
          const docSnap = await col.doc(String(excludeVideoId)).get();
          if (docSnap.exists) currentVideo = docSnap.data();
        }

        if (currentVideo) {
          // Normalize possible fields for tags/categories into arrays
          const tags = Array.isArray(currentVideo.tags) ? currentVideo.tags : (currentVideo.tags ? [String(currentVideo.tags)] : []);
          const categories = Array.isArray(currentVideo.categories) ? currentVideo.categories : (currentVideo.category ? [String(currentVideo.category)] : []);
          const terms = Array.from(new Set([].concat(tags || [], categories || []))).filter(Boolean).slice(0, 10);

          if (terms.length) {
            const fallbackIds = new Set();
            const fallbackItems = [];

            // Try querying tags (array-contains-any) if tag-like field exists
            if (tags.length) {
              const qTags = col.where('status', '==', 'Published').where('tags', 'array-contains-any', terms).limit(limit * 2);
              const snapTags = await qTags.get();
              snapTags.forEach((docSnap) => {
                const data = docSnap.data();
                if (!data) return;
                if (data.videoId && data.videoId === excludeVideoId) return;
                if (data.videoId && recentlyPlayed.includes(data.videoId)) return;
                if (fallbackIds.has(docSnap.id)) return;
                fallbackIds.add(docSnap.id);
                fallbackItems.push({ id: docSnap.id, ...data });
              });
            }

            // If still lacking, try categories field (array or single)
            if (fallbackItems.length < limit && categories.length) {
              // many codebases store category as 'category' or 'categories'
              // try array-contains-any on 'categories' and equality on 'category'
              try {
                const qCats = col.where('status', '==', 'Published').where('categories', 'array-contains-any', terms).limit(limit * 2);
                const snapCats = await qCats.get();
                snapCats.forEach((docSnap) => {
                  const data = docSnap.data();
                  if (!data) return;
                  if (data.videoId && data.videoId === excludeVideoId) return;
                  if (data.videoId && recentlyPlayed.includes(data.videoId)) return;
                  if (fallbackIds.has(docSnap.id)) return;
                  fallbackIds.add(docSnap.id);
                  fallbackItems.push({ id: docSnap.id, ...data });
                });
              } catch (e) {
                // if 'categories' isn't an array field or query fails, try 'category' equality
                try {
                  const qCatEq = col.where('status', '==', 'Published').where('category', 'in', terms).limit(limit * 2);
                  const snapCatEq = await qCatEq.get();
                  snapCatEq.forEach((docSnap) => {
                    const data = docSnap.data();
                    if (!data) return;
                    if (data.videoId && data.videoId === excludeVideoId) return;
                    if (data.videoId && recentlyPlayed.includes(data.videoId)) return;
                    if (fallbackIds.has(docSnap.id)) return;
                    fallbackIds.add(docSnap.id);
                    fallbackItems.push({ id: docSnap.id, ...data });
                  });
                } catch (ee) {
                  // ignore further errors
                }
              }
            }

            if (fallbackItems.length) {
              const normalizedFallback = fallbackItems.map((it) => {
                const playback = it.muxPlaybackId || it.videoId || it.playbackId || null;
                const thumbnail = it.horizontalThumbnailURL || it.thumbnailURL || (playback ? `https://image.mux.com/${playback}/thumbnail.jpg` : null);
                const channel = it.channelId ? (channelMap[it.channelId] || {}) : {};
                const author = channel.name || null;
                const channelLogo = channel.logoURL || channel.bannerURL || null;
                return {
                  it,
                  author,
                  channelLogo,
                };
              });

              // use the fallback results (limit to requested)
              return res.json({ ok: true, items: normalizedFallback.slice(0, limit) });
            }
          }
        }
      } catch (e) {
        // ignore fallback errors and continue to return empty results below
      }
    }

    // Final fallback: if still no items, return a random selection from
    // recently uploaded Published videos (shuffle the most recent batch)
    if ((!normalized || normalized.length === 0) && excludeVideoId) {
      try {
        const recentLimit = Math.max(limit * 2, 24);
        const recentQ = col.where('status', '==', 'Published').orderBy('uploadDate', 'desc').limit(recentLimit);
        const recentSnap = await recentQ.get();
        const recentItems = [];
        recentSnap.forEach((docSnap) => {
          const data = docSnap.data();
          if (!data) return;
          if (data.videoId && data.videoId === excludeVideoId) return;
          if (data.videoId && recentlyPlayed.includes(data.videoId)) return;
          recentItems.push({ id: docSnap.id, ...data });
        });

        if (recentItems.length) {
          // shuffle
          for (let i = recentItems.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            const tmp = recentItems[i];
            recentItems[i] = recentItems[j];
            recentItems[j] = tmp;
          }

          const normalizedRecent = recentItems.map((it) => {
            const playback = it.muxPlaybackId || it.videoId || it.playbackId || null;
            const thumbnail = it.horizontalThumbnailURL || it.thumbnailURL || (playback ? `https://image.mux.com/${playback}/thumbnail.jpg` : null);
            const channel = it.channelId ? (channelMap[it.channelId] || {}) : {};
            const author = channel.name || null;
            const channelLogo = channel.logoURL || null;
            return {
              it,
              author,
              channelLogo,
            };
          });

          // mark todo completed for this step
          try {
            await Promise.resolve();
          } catch (e) {}

          return res.json({ ok: true, items: normalizedRecent.slice(0, limit) });
        }
      } catch (e) {
        // ignore final fallback errors
      }
    }

    return res.json({ ok: true, items: normalized.slice(0, limit) });
  } catch (err) {
    console.error('Error in /api/v1/home/similar:', err);
    return res.status(500).json({ error: 'Failed to fetch similar videos', details: err.message || err });
  }
});

module.exports = router;
