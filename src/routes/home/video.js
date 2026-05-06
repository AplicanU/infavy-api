const express = require('express');
const router = express.Router();
const initFirebaseAdmin = require('../../lib/firebaseAdmin');
const { getBlockedChannelIds } = require('../../lib/blockedChannels');

/**
 * @openapi
 * /api/v1/home/video/{id}:
 *   get:
 *     summary: Get a video by id or query params
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: string
 */
// GET /api/v1/home/current
// Supports:
// - GET /api/v1/home/video/:id
// - GET /api/v1/home/video?id=... or ?videoId=... or ?playbackId=... or ?muxUploadId=...
router.get('/:id?', async (req, res) => {
  const adm = initFirebaseAdmin();
  if (!adm) return res.status(500).json({ error: 'Firebase Admin not initialized on server' });

  try {
    const db = adm.firestore();
    // accept id as path param (`/:id`) or query param `?id=`; prefer path param
    const idFromParams = req.params && req.params.id ? String(req.params.id) : null;
    const { videoId, playbackId, muxUploadId } = req.query;
    const id = idFromParams || (req.query && req.query.id ? String(req.query.id) : null);

    let foundDoc = null;

    // 1) try document id
    if (!foundDoc && id) {
      try {
        const ref = db.collection('videos').doc(String(id));
        const snap = await ref.get();
        if (snap.exists) foundDoc = snap;
      } catch (e) {}
    }

    // 2) try videoId
    if (!foundDoc && videoId) {
      const q = await db.collection('videos').where('videoId', '==', String(videoId)).limit(1).get();
      if (!q.empty) foundDoc = q.docs[0];
    }

    // 3) try muxPlaybackId or playbackId fields
    if (!foundDoc && playbackId) {
      let q = await db.collection('videos').where('muxPlaybackId', '==', String(playbackId)).limit(1).get();
      if (!q.empty) foundDoc = q.docs[0];
      else {
        const q2 = await db.collection('videos').where('playbackId', '==', String(playbackId)).limit(1).get();
        if (!q2.empty) foundDoc = q2.docs[0];
      }
    }

    // 4) try muxUploadId
    if (!foundDoc && muxUploadId) {
      const q = await db.collection('videos').where('muxUploadId', '==', String(muxUploadId)).limit(1).get();
      if (!q.empty) foundDoc = q.docs[0];
    }

    if (!foundDoc) return res.status(404).json({ ok: false, error: 'Video not found' });

    const data = foundDoc.data() || {};

    // If uid provided and user has blocked the channel, treat as not found
    const uid = typeof req.query.uid === 'string' && req.query.uid.trim() !== '' ? req.query.uid.trim() : (typeof req.query.userId === 'string' && req.query.userId.trim() !== '' ? req.query.userId.trim() : undefined);
    if (uid && data.channelId) {
      const blocked = await getBlockedChannelIds(db, uid);
      if (blocked.has(String(data.channelId))) return res.status(404).json({ ok: false, error: 'Video not found' });
    }

    // Resolve channel info if available
    let channel = null;
    try {
      if (data.channelId) {
        const chRef = db.collection('channels').doc(String(data.channelId));
        const chSnap = await chRef.get();
        if (chSnap.exists) channel = chSnap.data();
      }
    } catch (e) {
      // ignore
    }

    const playback = data.muxPlaybackId || data.playbackId || (data.mux && (data.mux.playback_ids?.[0]?.id || data.mux.playbackId)) || null;
    const thumbnail = data.horizontalThumbnailURL || data.thumbnailURL || (playback ? `https://image.mux.com/${playback}/thumbnail.jpg` : null);

    const response = {
      id: foundDoc.id,
      videoId: data.videoId || null,
      title: data.title || (data.meta && data.meta.title) || null,
      description: data.description || data.shortDescription || null,
      fullDescription: data.fullDescription || data.longDescription || null,
      author: data.creatorName || (channel && (channel.name || channel.owner)) || data.creatorId || null,
      channelId: data.channelId || null,
      channelName: channel?.name || null,
      channelLogo: channel?.logoURL || channel?.bannerURL || channel?.profileImage || null,
      playbackId: playback,
      muxAssetId: data.muxAssetId || null,
      muxUploadId: data.muxUploadId || null,
      thumbnail,
      horizontalThumbnailURL: data.horizontalThumbnailURL || null,
      verticalThumbnailURL: data.verticalThumbnailURL || null,
      views: data.views || 0,
      tags: data.tags || null,
      categories: data.categories || null,
      status: data.status || null,
      type: data.type || null,
      uploadDate: data.uploadDate || null,
      raw: data,
    };

    return res.json({ ok: true, video: response });
  } catch (err) {
    console.error('Error in /api/v1/home/current:', err);
    return res.status(500).json({ error: 'Failed to fetch current video', details: err.message || err });
  }
});

module.exports = router;
