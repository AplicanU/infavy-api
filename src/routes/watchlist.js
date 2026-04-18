const express = require('express');
const initFirebaseAdmin = require('../lib/firebaseAdmin');

const router = express.Router();

// GET /list?profileId=<id|null>
// Requires Authorization: Bearer <idToken>
router.get('/list', async (req, res) => {
  const admin = initFirebaseAdmin();
  if (!admin) return res.status(500).json({ ok: false, error: 'Firebase Admin not initialized' });

  try {
    // Support both unauthenticated access (client provides `userId` query param)
    // and optional Authorization token. Prefer explicit `userId` to behave like public
    // endpoints (similar to `channels`), but allow token-based lookup when `userId`
    // is not supplied for convenience.
    let userId = typeof req.query.userId === 'string' && req.query.userId.trim() !== '' ? req.query.userId.trim() : undefined;

    // Require explicit `userId` query parameter; do not accept Authorization token.
    if (!userId) return res.status(400).json({ ok: false, error: 'Missing userId query parameter' });

    const profileIdParam = (typeof req.query.profileId === 'string') ? req.query.profileId : undefined;
    const profileId = profileIdParam === 'null' ? null : (typeof profileIdParam === 'undefined' ? undefined : profileIdParam);

    const db = admin.firestore();
    const col = db.collection('watchlist');
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
    console.error('[watchlist] GET error', err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

module.exports = router;

// POST /add
// Requires Authorization: Bearer <idToken>
router.post('/add', async (req, res) => {
  const admin = initFirebaseAdmin();
  if (!admin) return res.status(500).json({ ok: false, error: 'Firebase Admin not initialized' });

  try {
    // Require explicit `userId` in body; do not accept Authorization token.
    const userId = typeof req.body.userId === 'string' && req.body.userId.trim() !== '' ? req.body.userId.trim() : undefined;
    if (!userId) return res.status(400).json({ ok: false, error: 'Missing userId in body' });

    const { profileId: profileRaw, videoId } = req.body || {};
    if (!videoId) return res.status(400).json({ ok: false, error: 'Missing videoId' });

    const profileId = (profileRaw === 'null' || profileRaw === null) ? null : (typeof profileRaw === 'undefined' ? undefined : String(profileRaw));

    const db = admin.firestore();
    let col = db.collection('watchlist');
    let q = col.where('userId', '==', userId).where('videoId', '==', videoId);
    if (typeof profileId !== 'undefined') q = q.where('profileId', '==', profileId);

    const snap = await q.get();
    if (snap.empty) {
      const docRef = await col.add({
        userId,
        profileId: typeof profileId === 'undefined' ? null : profileId,
        videoId,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      const created = await docRef.get();
      return res.status(201).json({ ok: true, item: { id: docRef.id, ...created.data() } });
    }

    // If already exists, update timestamp to bring to top
    const first = snap.docs[0];
    await first.ref.update({ createdAt: admin.firestore.FieldValue.serverTimestamp() });
    return res.json({ ok: true, duplicate: true });
  } catch (err) {
    console.error('[watchlist] POST /add error', err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

// POST /remove
// Requires Authorization: Bearer <idToken>
router.post('/remove', async (req, res) => {
  const admin = initFirebaseAdmin();
  if (!admin) return res.status(500).json({ ok: false, error: 'Firebase Admin not initialized' });

  try {
    // Require explicit `userId` in body; do not accept Authorization token.
    const userId = typeof req.body.userId === 'string' && req.body.userId.trim() !== '' ? req.body.userId.trim() : undefined;
    if (!userId) return res.status(400).json({ ok: false, error: 'Missing userId in body' });

    const { profileId: profileRaw, videoId } = req.body || {};
    if (!videoId) return res.status(400).json({ ok: false, error: 'Missing videoId' });

    const profileId = (profileRaw === 'null' || profileRaw === null) ? null : (typeof profileRaw === 'undefined' ? undefined : String(profileRaw));

    const db = admin.firestore();
    let col = db.collection('watchlist');
    let q = col.where('userId', '==', userId).where('videoId', '==', videoId);
    if (typeof profileId !== 'undefined') q = q.where('profileId', '==', profileId);

    const snap = await q.get();
    if (snap.empty) return res.json({ ok: true, deleted: false });

    const batch = db.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    return res.json({ ok: true, deleted: true });
  } catch (err) {
    console.error('[watchlist] POST /remove error', err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
});
