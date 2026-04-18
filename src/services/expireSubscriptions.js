const initFirebaseAdmin = require('../lib/firebaseAdmin');

/**
 * expireSubscriptions - find subscriptions with endDate < now and mark them expired.
 * Safe to run daily and idempotent.
 */
async function expireSubscriptions() {
  const admin = initFirebaseAdmin();
  if (!admin) throw new Error('Firebase Admin not initialized');
  const db = admin.firestore();

  const now = admin.firestore.Timestamp.now();
  const pageSize = 200;

  const queryBase = db.collection('subscriptions')
    .where('endDate', '<', now)
    .where('status', '!=', 'expired')
    .limit(pageSize);

  let batch = db.batch();
  let processed = 0;
  let q = await queryBase.get();
  while (!q.empty) {
    q.forEach((doc) => {
      batch.update(doc.ref, { status: 'expired', updatedAt: now });
      processed += 1;
    });

    await batch.commit();
    batch = db.batch();

    // get next page
    q = await queryBase.get();
  }

  return { processed };
}

module.exports = expireSubscriptions;
