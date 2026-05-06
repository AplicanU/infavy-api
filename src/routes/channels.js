const express = require('express');
const router = express.Router();
const initFirebaseAdmin = require('../lib/firebaseAdmin');
const { getBlockedChannelIds } = require('../lib/blockedChannels');

/**
 * @openapi
 * /api/v1/channels/blocked:
 *   get:
 *     summary: Get blocked channels for a user
 *     parameters:
 *       - in: query
 *         name: uid
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: List of blocked channels
 *
 * /api/v1/channels:
 *   get:
 *     summary: List channels
 *   post:
 *     summary: Create a channel
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *     responses:
 *       200:
 *         description: OK
 *
 * /api/v1/channels/{id}:
 *   get:
 *     summary: Get channel by id
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *   put:
 *     summary: Update channel by id
 *   delete:
 *     summary: Delete channel by id
 *
 * /api/v1/channels/{id}/videos:
 *   get:
 *     summary: Get videos for a channel
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *
 * /api/v1/channels/block:
 *   post:
 *     summary: Block a channel for a user
 *
 * /api/v1/channels/unblock:
 *   post:
 *     summary: Unblock a channel for a user
 */
router.get('/blocked', async (req, res) => {
  const adm = initFirebaseAdmin();
  if (!adm) return res.status(500).json({ error: 'Firebase Admin not initialized on server' });

  try {
    const uid = typeof req.query.uid === 'string' && req.query.uid.trim() !== '' ? req.query.uid.trim() : (typeof req.query.userId === 'string' && req.query.userId.trim() !== '' ? req.query.userId.trim() : undefined);
    if (!uid) return res.status(400).json({ error: 'Missing uid (or userId) in query' });


    const db = adm.firestore();
    const col = db.collection('blockedChannels');
    let q = col.where('uid', '==', uid);
    q = q.orderBy('createdAt', 'desc');

    const snap = await q.get();
    if (snap.empty) return res.json({ ok: true, items: [] });

    const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    return res.json({ ok: true, items });
  } catch (err) {
    console.error('Error in /api/v1/home/channels/blocked [GET]:', err);
    return res.status(500).json({ error: 'Failed to fetch blocked channels', details: err.message || err });
  }
});

router.get('/', async (req, res) => {
  const adm = initFirebaseAdmin();
  if (!adm) return res.status(500).json({ error: 'Firebase Admin not initialized on server' });

  try {
    const db = adm.firestore();
    const uid = typeof req.query.uid === 'string' && req.query.uid.trim() !== '' ? req.query.uid.trim() : (typeof req.query.userId === 'string' && req.query.userId.trim() !== '' ? req.query.userId.trim() : undefined);

    const snap = await db.collection('channels').get();
    let channels = snap.docs.map((d) => {
      const data = d.data() || {};
      return {
        id: d.id,
        ...data,
        logoURL: data.logoURL || data.thumbnail || data.logo || null,
      };
    });

    // If uid provided, filter out channels the user has blocked
    if (uid) {
      const blocked = await getBlockedChannelIds(db, uid);
      if (blocked && blocked.size) {
        channels = channels.filter((c) => !blocked.has(String(c.id)));
      }
    }

    return res.json({ ok: true, channels });
  } catch (err) {
    console.error('Error in /api/v1/home/channels [GET]:', err);
    return res.status(500).json({ error: 'Failed to fetch channels', details: err.message || err });
  }
});

router.get('/:id', async (req, res) => {
  const adm = initFirebaseAdmin();
  if (!adm) return res.status(500).json({ error: 'Firebase Admin not initialized on server' });

  try {
    const db = adm.firestore();
    const doc = await db.collection('channels').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'Channel not found' });
    const data = doc.data() || {};
    return res.json({ ok: true, channel: { id: doc.id, ...data, logoURL: data.logoURL || data.thumbnail || data.logo || null } });
  } catch (err) {
    console.error('Error in /api/v1/home/channels/:id [GET]:', err);
    return res.status(500).json({ error: 'Failed to fetch channel', details: err.message || err });
  }
});

// GET /:id/videos
// Returns videos for a given channel document id with playbackId and thumbnail enrichment
router.get('/:id/videos', async (req, res) => {
  const adm = initFirebaseAdmin();
  if (!adm) return res.status(500).json({ error: 'Firebase Admin not initialized on server' });

  try {
    const db = adm.firestore();
    const channelId = req.params.id;
    const uid = typeof req.query.uid === 'string' && req.query.uid.trim() !== '' ? req.query.uid.trim() : (typeof req.query.userId === 'string' && req.query.userId.trim() !== '' ? req.query.userId.trim() : undefined);
    const limit = Math.min(200, Number(req.query.limit) || 100);
    // Fetch the channel once to enrich videos with channel name as `author`
    const channelRef = db.collection('channels').doc(String(channelId));
    const channelDoc = await channelRef.get();
    const channelName = channelDoc.exists ? (channelDoc.data().name || null) : null;
    const channelLogo = channelDoc.exists ? (channelDoc.data().logoURL || channelDoc.data().bannerURL || channelDoc.data().logo || null) : null;

    // If uid provided and user has blocked this channel, return empty set
    if (uid) {
      const blocked = await getBlockedChannelIds(db, uid);
      if (blocked.has(String(channelId))) return res.json({ ok: true, channelId, count: 0, videos: [] });
    }

    const q = db.collection('videos').where('channelId', '==', String(channelId)).limit(limit);
    const snap = await q.get();
    // Only include published videos. Support multiple common field names.
    const publishedDocs = snap.docs.filter((d) => {
      const v = d.data() || {};
      return v.published === true || v.isPublished === true || v.status === 'Published';
    });

    const videos = publishedDocs.map((d) => {
      const v = d.data() || {};
      const playbackId =
        v.muxPlaybackId || v.playbackId || (v.mux && (v.mux.playback_ids?.[0]?.id || v.mux.playbackId)) || null;

      const thumbnail =
        v.horizontalThumbnailURL || v.thumbnail || v.thumbnailURL || (playbackId ? `https://image.mux.com/${playbackId}/thumbnail.jpg` : null) || null;

      return {
        id: d.id,
        ...v,
        playbackId,
        thumbnail,
        author: channelName || v.channelName || null,
        channelLogo: channelLogo || v.logoURL || null,
      };
    });

    return res.json({ ok: true, channelId, count: publishedDocs.length, videos });
  } catch (err) {
    console.error('Error in /api/v1/channels/:id/videos [GET]:', err);
    return res.status(500).json({ error: 'Failed to fetch channel videos', details: err.message || err });
  }
});

router.post('/', async (req, res) => {
  const adm = initFirebaseAdmin();
  if (!adm) return res.status(500).json({ error: 'Firebase Admin not initialized on server' });

  try {
    const db = adm.firestore();
    const payload = req.body || {};

    // Minimal validation
    if (!payload.name) return res.status(400).json({ error: 'Missing required field: name' });

    const now = Date.now();
    const toSave = {
      name: payload.name,
      owner: payload.owner || null,
      bannerURL: payload.bannerURL || null,
      shortDescription: payload.shortDescription || null,
      isVerified: !!payload.isVerified,
      createdAt: now,
      updatedAt: now,
      ...payload.extraFields,
    };

    const ref = await db.collection('channels').add(toSave);
    const doc = await ref.get();
    return res.status(201).json({ ok: true, channel: { id: doc.id, ...doc.data() } });
  } catch (err) {
    console.error('Error in /api/v1/home/channels [POST]:', err);
    return res.status(500).json({ error: 'Failed to create channel', details: err.message || err });
  }
});

router.put('/:id', async (req, res) => {
  const adm = initFirebaseAdmin();
  if (!adm) return res.status(500).json({ error: 'Firebase Admin not initialized on server' });

  try {
    const db = adm.firestore();
    const payload = req.body || {};
    const docRef = db.collection('channels').doc(req.params.id);
    const doc = await docRef.get();
    if (!doc.exists) return res.status(404).json({ error: 'Channel not found' });

    const update = { ...payload, updatedAt: Date.now() };
    await docRef.update(update);
    const updated = await docRef.get();
    return res.json({ ok: true, channel: { id: updated.id, ...updated.data() } });
  } catch (err) {
    console.error('Error in /api/v1/home/channels/:id [PUT]:', err);
    return res.status(500).json({ error: 'Failed to update channel', details: err.message || err });
  }
});

router.delete('/:id', async (req, res) => {
  const adm = initFirebaseAdmin();
  if (!adm) return res.status(500).json({ error: 'Firebase Admin not initialized on server' });

  try {
    const db = adm.firestore();
    const docRef = db.collection('channels').doc(req.params.id);
    const doc = await docRef.get();
    if (!doc.exists) return res.status(404).json({ error: 'Channel not found' });
    await docRef.delete();
    return res.json({ ok: true, id: req.params.id });
  } catch (err) {
    console.error('Error in /api/v1/home/channels/:id [DELETE]:', err);
    return res.status(500).json({ error: 'Failed to delete channel', details: err.message || err });
  }
});

// POST /block
// Body: { uid|userId, channelId, category?, message? }
// Adds a document to `blockedChannels` collection. Prevents duplicate blocks for same uid+channelId.
router.post('/block', async (req, res) => {
  const adm = initFirebaseAdmin();
  if (!adm) return res.status(500).json({ error: 'Firebase Admin not initialized on server' });

  try {
    const db = adm.firestore();
    const body = req.body || {};
    const uid = typeof body.uid === 'string' && body.uid.trim() !== '' ? body.uid.trim() : (typeof body.userId === 'string' && body.userId.trim() !== '' ? body.userId.trim() : undefined);
    const channelId = body.channelId || body.channel || undefined;
    const category = typeof body.category === 'string' ? body.category : null;
    const message = typeof body.message === 'string' ? body.message : null;

    if (!uid) return res.status(400).json({ error: 'Missing uid (or userId) in body' });
    if (!channelId) return res.status(400).json({ error: 'Missing channelId in body' });

    const col = db.collection('blockedChannels');
    // Check if already blocked by same user for same channel
    let q = col.where('uid', '==', uid).where('channelId', '==', String(channelId));
    const snap = await q.get();
    if (!snap.empty) {
      // If an existing block exists, return duplicate
      return res.json({ ok: true, duplicate: true });
    }

    const toSave = {
      uid,
      channelId: String(channelId),
      category,
      message,
      createdAt: adm.firestore.FieldValue.serverTimestamp(),
    };

    const ref = await col.add(toSave);
    const created = await ref.get();
    return res.status(201).json({ ok: true, item: { id: ref.id, ...created.data() } });
  } catch (err) {
    console.error('Error in /api/v1/home/channels/block [POST]:', err);
    return res.status(500).json({ error: 'Failed to block channel', details: err.message || err });
  }
});

// POST /unblock
// Body: { uid|userId, channelId, category? }
// Removes matching documents from `blockedChannels` collection.
router.post('/unblock', async (req, res) => {
  const adm = initFirebaseAdmin();
  if (!adm) return res.status(500).json({ error: 'Firebase Admin not initialized on server' });

  try {
    const db = adm.firestore();
    const body = req.body || {};
    const uid = typeof body.uid === 'string' && body.uid.trim() !== '' ? body.uid.trim() : (typeof body.userId === 'string' && body.userId.trim() !== '' ? body.userId.trim() : undefined);
    const channelId = body.channelId || body.channel || undefined;
    const category = typeof body.category === 'undefined' ? undefined : body.category;

    if (!uid) return res.status(400).json({ error: 'Missing uid (or userId) in body' });
    if (!channelId) return res.status(400).json({ error: 'Missing channelId in body' });

    const col = db.collection('blockedChannels');
    let q = col.where('uid', '==', uid).where('channelId', '==', String(channelId));
    if (typeof category !== 'undefined') q = q.where('category', '==', category);

    const snap = await q.get();
    if (snap.empty) return res.json({ ok: true, deleted: false });

    const batch = db.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();

    return res.json({ ok: true, deleted: true, removed: snap.size });
  } catch (err) {
    console.error('Error in /api/v1/home/channels/unblock [POST]:', err);
    return res.status(500).json({ error: 'Failed to unblock channel', details: err.message || err });
  }
});



module.exports = router;
