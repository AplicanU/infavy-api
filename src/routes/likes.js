const express = require('express');
const initFirebaseAdmin = require('../lib/firebaseAdmin');

const router = express.Router();

function makeLikeDocId(userId, videoId, profileId) {
  const u = String(userId || '');
  const v = String(videoId || '');
  const p = (profileId === null) ? 'null' : (typeof profileId === 'undefined' ? 'undefined' : String(profileId));
  // Keep id filesystem-safe-ish
  return encodeURIComponent(u) + '|' + encodeURIComponent(v) + '|' + encodeURIComponent(p);
}

/**
 * @openapi
 * /api/v1/likes/like:
 *   post:
 *     summary: Like a video
 *
 * /api/v1/likes/unlike:
 *   post:
 *     summary: Unlike a video
 *
 * /api/v1/likes/list:
 *   get:
 *     summary: List liked videos for a user
 */
router.post('/like', async (req, res) => {
  const admin = initFirebaseAdmin();
  if (!admin) return res.status(500).json({ ok: false, error: 'Firebase Admin not initialized' });

  try {
    // Require POST JSON body: `userId`, `videoId`, optional `profileId`.
    const userId = (typeof req.body.userId === 'string' && req.body.userId.trim() !== '') ? req.body.userId.trim() : undefined;
    if (!userId) return res.status(400).json({ ok: false, error: 'Missing userId in body' });

    const videoId = (typeof req.body.videoId === 'string' && req.body.videoId.trim() !== '') ? req.body.videoId.trim() : undefined;
    if (!videoId) return res.status(400).json({ ok: false, error: 'Missing videoId in body' });

    const profileRaw = req.body.profileId;
    const profileId = (profileRaw === 'null' || profileRaw === null) ? null : (typeof profileRaw === 'undefined' ? undefined : String(profileRaw));

    const db = admin.firestore();

    const likeDocId = makeLikeDocId(userId, videoId, profileId);
    const likeRef = db.collection('videoLikes').doc(likeDocId);
    const likeSnap = await likeRef.get();
    if (likeSnap.exists) {
      return res.json({ ok: true, duplicate: true });
    }

    const videoRef = db.collection('videos').doc(String(videoId));

    // Use transaction to create like doc and increment likes atomically
    const result = await db.runTransaction(async (tx) => {
      const vSnap = await tx.get(videoRef).catch(() => null);
      let currentLikes = 0;
      if (vSnap && vSnap.exists) {
        const data = vSnap.data() || {};
        currentLikes = typeof data.likes === 'number' ? data.likes : (data.likes ? Number(data.likes) : 0);
      }

      const newLikes = currentLikes + 1;
      tx.set(videoRef, { likes: newLikes }, { merge: true });

      tx.set(likeRef, {
        userId,
        profileId: typeof profileId === 'undefined' ? null : profileId,
        videoId,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      return newLikes;
    });

    return res.status(201).json({ ok: true, likes: result });
  } catch (err) {
    console.error('[likes] POST /like error', err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

// POST /unlike
// Body: { userId?, profileId?, videoId }
router.post('/unlike', async (req, res) => {
  const admin = initFirebaseAdmin();
  if (!admin) return res.status(500).json({ ok: false, error: 'Firebase Admin not initialized' });

  try {
    // Require POST JSON body: `userId`, `videoId`, optional `profileId`.
    const userId = (typeof req.body.userId === 'string' && req.body.userId.trim() !== '') ? req.body.userId.trim() : undefined;
    if (!userId) return res.status(400).json({ ok: false, error: 'Missing userId in body' });

    const videoId = (typeof req.body.videoId === 'string' && req.body.videoId.trim() !== '') ? req.body.videoId.trim() : undefined;
    if (!videoId) return res.status(400).json({ ok: false, error: 'Missing videoId in body' });

    const profileRaw = req.body.profileId;
    const profileId = (profileRaw === 'null' || profileRaw === null) ? null : (typeof profileRaw === 'undefined' ? undefined : String(profileRaw));

    const db = admin.firestore();
    const likeDocId = makeLikeDocId(userId, videoId, profileId);
    const likeRef = db.collection('videoLikes').doc(likeDocId);
    const likeSnap = await likeRef.get();
    if (!likeSnap.exists) {
      return res.json({ ok: true, deleted: false });
    }

    const videoRef = db.collection('videos').doc(String(videoId));

    // Use transaction to delete like doc and decrement likes safely
    const result = await db.runTransaction(async (tx) => {
      const vSnap = await tx.get(videoRef).catch(() => null);
      let currentLikes = 0;
      if (vSnap && vSnap.exists) {
        const data = vSnap.data() || {};
        currentLikes = typeof data.likes === 'number' ? data.likes : (data.likes ? Number(data.likes) : 0);
      }

      const newLikes = Math.max(0, currentLikes - 1);
      tx.set(videoRef, { likes: newLikes }, { merge: true });
      tx.delete(likeRef);
      return newLikes;
    });

    return res.json({ ok: true, deleted: true, likes: result });
  } catch (err) {
    console.error('[likes] POST /unlike error', err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

// GET /list?profileId=<id|null>
// Requires explicit `userId` query parameter; does not accept Authorization token.
router.get('/list', async (req, res) => {
  const admin = initFirebaseAdmin();
  if (!admin) return res.status(500).json({ ok: false, error: 'Firebase Admin not initialized' });

  try {
    // Require explicit `userId` query parameter; do not accept Authorization token.
    let userId = typeof req.query.userId === 'string' && req.query.userId.trim() !== '' ? req.query.userId.trim() : undefined;
    if (!userId) return res.status(400).json({ ok: false, error: 'Missing userId query parameter' });

    const profileIdParam = (typeof req.query.profileId === 'string') ? req.query.profileId : undefined;
    const profileId = profileIdParam === 'null' ? null : (typeof profileIdParam === 'undefined' ? undefined : profileIdParam);

    const db = admin.firestore();
    const col = db.collection('videoLikes');
    const q = col.where('userId', '==', userId);
    const snap = await q.get();
    let items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

    if (typeof profileId !== 'undefined') {
      if (profileId === null) {
        items = items.filter((it) => it.profileId === null || typeof it.profileId === 'undefined');
      } else {
        items = items.filter((it) => String(it.profileId) === String(profileId));
      }
    }

    items.sort((a, b) => {
      const ta = a.createdAt && a.createdAt.toMillis ? a.createdAt.toMillis() : (a.createdAt && a.createdAt.seconds ? a.createdAt.seconds * 1000 : (a.createdAt instanceof Date ? a.createdAt.getTime() : Date.parse(String(a.createdAt) || '')));
      const tb = b.createdAt && b.createdAt.toMillis ? b.createdAt.toMillis() : (b.createdAt && b.createdAt.seconds ? b.createdAt.seconds * 1000 : (b.createdAt instanceof Date ? b.createdAt.getTime() : Date.parse(String(b.createdAt) || '')));
      return (tb || 0) - (ta || 0);
    });

    return res.json({ ok: true, items });
  } catch (err) {
    console.error('[likes] GET /list error', err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

module.exports = router;
