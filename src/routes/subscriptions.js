const express = require('express');
const initFirebaseAdmin = require('../lib/firebaseAdmin');

const router = express.Router();

/**
 * @openapi
 * /api/v1/subscriptions/subscribe:
 *   post:
 *     summary: Subscribe a user to a channel
 *
 * /api/v1/subscriptions/unsubscribe:
 *   post:
 *     summary: Unsubscribe a user from a channel
 *
 * /api/v1/subscriptions/list:
 *   get:
 *     summary: List subscriptions for a user
 */
router.post('/subscribe', async (req, res) => {
  const admin = initFirebaseAdmin();
  if (!admin) return res.status(500).json({ ok: false, error: 'Firebase Admin not initialized' });

  try {
    // Require explicit `userId` in body; do not accept Authorization token.
    const userId = typeof req.body.userId === 'string' && req.body.userId.trim() !== '' ? req.body.userId.trim() : undefined;
    if (!userId) return res.status(400).json({ ok: false, error: 'Missing userId in body' });

    const { profileId: profileRaw, channelId } = req.body || {};
    if (!channelId) return res.status(400).json({ ok: false, error: 'Missing channelId' });

    const profileId = (profileRaw === 'null' || profileRaw === null) ? null : (typeof profileRaw === 'undefined' ? undefined : String(profileRaw));

    const db = admin.firestore();
    const col = db.collection('channelSubscriptions');
    let q = col.where('userId', '==', userId).where('channelId', '==', channelId);
    if (typeof profileId !== 'undefined') q = q.where('profileId', '==', profileId);

    const snap = await q.get();
    if (snap.empty) {
      const docRef = await col.add({
        userId,
        profileId: typeof profileId === 'undefined' ? null : profileId,
        channelId,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // increment channel subscriber count
      try {
        await db.collection('channels').doc(channelId).set({ subscriberCount: admin.firestore.FieldValue.increment(1) }, { merge: true });
      } catch (e) {
        console.warn('[subscriptions] failed to increment subscriberCount', e);
      }

      const created = await docRef.get();
      return res.status(201).json({ ok: true, item: { id: docRef.id, ...created.data() } });
    }

    // already subscribed — update timestamp
    const first = snap.docs[0];
    await first.ref.update({ createdAt: admin.firestore.FieldValue.serverTimestamp() });
    return res.json({ ok: true, duplicate: true });
  } catch (err) {
    console.error('[subscriptions] POST /subscribe error', err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

// POST /unsubscribe
// Body: { userId?, profileId?, channelId }
router.post('/unsubscribe', async (req, res) => {
  const admin = initFirebaseAdmin();
  if (!admin) return res.status(500).json({ ok: false, error: 'Firebase Admin not initialized' });

  try {
    // Require explicit `userId` in body; do not accept Authorization token.
    const userId = typeof req.body.userId === 'string' && req.body.userId.trim() !== '' ? req.body.userId.trim() : undefined;
    if (!userId) return res.status(400).json({ ok: false, error: 'Missing userId in body' });

    const { profileId: profileRaw, channelId } = req.body || {};
    if (!channelId) return res.status(400).json({ ok: false, error: 'Missing channelId' });

    const profileId = (profileRaw === 'null' || profileRaw === null) ? null : (typeof profileRaw === 'undefined' ? undefined : String(profileRaw));

    const db = admin.firestore();
    const col = db.collection('channelSubscriptions');
    let q = col.where('userId', '==', userId).where('channelId', '==', channelId);
    if (typeof profileId !== 'undefined') q = q.where('profileId', '==', profileId);

    const snap = await q.get();
    if (snap.empty) return res.json({ ok: true, deleted: false });

    const batch = db.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();

    // decrement subscriber count by number of removed docs
    try {
      const removed = snap.size || snap.docs.length || 1;
      await db.collection('channels').doc(channelId).set({ subscriberCount: admin.firestore.FieldValue.increment(-1 * removed) }, { merge: true });
    } catch (e) {
      console.warn('[subscriptions] failed to decrement subscriberCount', e);
    }

    return res.json({ ok: true, deleted: true });
  } catch (err) {
    console.error('[subscriptions] POST /unsubscribe error', err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

// GET /list
// Query: ?userId=<userId>&profileId=<profileId>
// Returns list of subscriptions for the explicit user and optional profile.
router.get('/list', async (req, res) => {
  const admin = initFirebaseAdmin();
  if (!admin) return res.status(500).json({ ok: false, error: 'Firebase Admin not initialized' });

  try {
    // Require explicit `userId` in query; do not accept Authorization token.
    const userId = typeof req.query.userId === 'string' && req.query.userId.trim() !== '' ? req.query.userId.trim() : undefined;
    if (!userId) return res.status(400).json({ ok: false, error: 'Missing userId in query' });

    const profileRaw = typeof req.query.profileId === 'undefined' ? undefined : req.query.profileId;
    const profileId = (profileRaw === 'null' || profileRaw === null) ? null : (typeof profileRaw === 'undefined' ? undefined : String(profileRaw));

    const db = admin.firestore();
    const col = db.collection('channelSubscriptions');
    let q = col.where('userId', '==', userId);
    if (typeof profileId !== 'undefined') q = q.where('profileId', '==', profileId);
    // order by most recent subscription first when available
    q = q.orderBy('createdAt', 'desc');

    const snap = await q.get();
    if (snap.empty) return res.json({ ok: true, items: [] });

    const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    return res.json({ ok: true, items });
  } catch (err) {
    console.error('[subscriptions] GET /list error', err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

module.exports = router;
