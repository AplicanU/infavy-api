const express = require('express');
const initFirebaseAdmin = require('../lib/firebaseAdmin');

const router = express.Router();

// POST /sync
// Body: { uid, revenuecatSubscriptionId?, status?, startDate?, endDate?, revenuecatTransactionId?, lastProcessedPaymentId?, amount? }
// Compares frontend-provided subscription data with DB (webhook truth). Prefers webhook data.
router.post('/sync', async (req, res) => {
  const admin = initFirebaseAdmin();
  if (!admin) return res.status(500).json({ ok: false, error: 'Firebase Admin not initialized' });

  try {
    const incoming = req.body || {};
    const uid = typeof incoming.uid === 'string' && incoming.uid.trim() !== '' ? incoming.uid.trim() : undefined;
    if (!uid) return res.status(400).json({ ok: false, error: 'Missing uid in body' });

    const db = admin.firestore();
    let q = db.collection('subscriptions').where('uid', '==', uid);
    if (incoming.revenuecatSubscriptionId) q = db.collection('subscriptions').where('revenuecatSubscriptionId', '==', incoming.revenuecatSubscriptionId);

    const snap = await q.limit(1).get();
    if (snap.empty) return res.status(404).json({ ok: false, error: 'subscription not found' });

    const doc = snap.docs[0];
    const data = doc.data();

    // Compute canonical status (do not trust incoming status blindly)
    const now = Date.now();
    const endMs = data.endDate && data.endDate.toDate ? data.endDate.toDate().getTime() : (data.endDate ? new Date(data.endDate).getTime() : null);
    const computedStatus = endMs && now > endMs ? 'inactive' : (data.status || 'active');

    // Compare fields and collect discrepancies
    const compareField = (k, incomingVal, dbVal) => {
      if (incomingVal == null && dbVal == null) return null;
      // normalize Firestore Timestamps to millis for comparison
      if (dbVal && dbVal.toDate) dbVal = dbVal.toDate().getTime();
      if (incomingVal && typeof incomingVal === 'string' && /^\d+$/.test(incomingVal)) incomingVal = Number(incomingVal);
      if (incomingVal !== dbVal) return { field: k, incoming: incomingVal, db: dbVal };
      return null;
    };

    const fieldsToCheck = ['status', 'revenuecatSubscriptionId', 'revenuecatTransactionId', 'lastProcessedPaymentId', 'amount'];
    const discrepancies = [];
    fieldsToCheck.forEach((f) => {
      const inc = incoming[f];
      const dbv = data[f];
      const diff = compareField(f, inc, dbv);
      if (diff) discrepancies.push(diff);
    });
    // check dates
    const d1 = compareField('startDate', incoming.startDate, data.startDate);
    const d2 = compareField('endDate', incoming.endDate, data.endDate);
    if (d1) discrepancies.push(d1);
    if (d2) discrepancies.push(d2);

    // Always prefer DB/webhook truth. Optionally log discrepancy
    if (discrepancies.length) {
      console.log('[userSubscriptions.sync] discrepancy for uid', uid, { discrepancies });
    }

    // Ensure users table reflects subscription computed status
    try {
      await db.collection('users').doc(String(uid)).set({ isSubscribed: computedStatus === 'active', updatedAt: admin.firestore.Timestamp.now() }, { merge: true });
    } catch (e) {
      console.warn('[userSubscriptions.sync] failed to sync users table', e);
    }

    const out = { id: doc.id, uid: data.uid, status: computedStatus, startDate: data.startDate, endDate: data.endDate, revenuecatSubscriptionId: data.revenuecatSubscriptionId, revenuecatTransactionId: data.revenuecatTransactionId, lastProcessedPaymentId: data.lastProcessedPaymentId, amount: data.amount, updatedAt: data.updatedAt, discrepancies };
    return res.json({ ok: true, source: 'webhook', item: out });
  } catch (err) {
    console.error('[userSubscriptions] POST /sync error', err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

module.exports = router;

// GET /:uid
// Returns canonical subscription details for a specific user (prefers webhook/DB data)
router.get('/:uid', async (req, res) => {
  const admin = initFirebaseAdmin();
  if (!admin) return res.status(500).json({ ok: false, error: 'Firebase Admin not initialized' });

  try {
    const uid = req.params.uid || req.query.uid;
    if (!uid) return res.status(400).json({ ok: false, error: 'Missing uid in path or query' });

    const db = admin.firestore();
    let q = db.collection('subscriptions').where('uid', '==', uid);
    if (req.query.revenuecatSubscriptionId) q = db.collection('subscriptions').where('revenuecatSubscriptionId', '==', req.query.revenuecatSubscriptionId);

    const snap = await q.limit(1).get();
    if (snap.empty) return res.status(404).json({ ok: false, error: 'subscription not found' });

    const doc = snap.docs[0];
    const data = doc.data();

    const now = Date.now();
    const endMs = data.endDate && data.endDate.toDate ? data.endDate.toDate().getTime() : (data.endDate ? new Date(data.endDate).getTime() : null);
    const computedStatus = endMs && now > endMs ? 'inactive' : (data.status || 'active');

    const item = {
      id: doc.id,
      uid: data.uid,
      status: computedStatus,
      startDate: data.startDate,
      endDate: data.endDate,
      revenuecatSubscriptionId: data.revenuecatSubscriptionId,
      revenuecatTransactionId: data.revenuecatTransactionId,
      lastProcessedPaymentId: data.lastProcessedPaymentId,
      amount: data.amount,
      retryCount: data.retryCount || 0,
      updatedAt: data.updatedAt,
    };

    return res.json({ ok: true, source: 'webhook', item });
  } catch (err) {
    console.error('[userSubscriptions] GET /:uid error', err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

// GET /:uid/activity
// Returns recent subscription activity entries for a user (from `subscriptionActivity` collection)
router.get('/:uid/activity', async (req, res) => {
  const admin = initFirebaseAdmin();
  if (!admin) return res.status(500).json({ ok: false, error: 'Firebase Admin not initialized' });

  try {
    const uid = req.params.uid || req.query.uid;
    if (!uid) return res.status(400).json({ ok: false, error: 'Missing uid in path or query' });

    const db = admin.firestore();
    const limit = (req.query.limit && Number.isFinite(Number(req.query.limit))) ? Math.min(200, Math.max(1, Number(req.query.limit))) : 50;

    // Query activity by uid, most recent first
    let q = db.collection('subscriptionActivity').where('uid', '==', uid).orderBy('time', 'desc');
    const snap = await q.limit(limit).get();
    if (snap.empty) return res.json({ ok: true, items: [] });

    const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    return res.json({ ok: true, source: 'webhook', items });
  } catch (err) {
    console.error('[userSubscriptions] GET /:uid/activity error', err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
});
