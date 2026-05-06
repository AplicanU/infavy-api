const initFirebaseAdmin = require('../lib/firebaseAdmin');

const DAY_MS = 24 * 60 * 60 * 1000;

function tsFromDate(date) {
  const admin = initFirebaseAdmin();
  return admin.firestore.Timestamp.fromDate(date);
}

async function getFirestore() {
  const admin = initFirebaseAdmin();
  if (!admin) throw new Error('Firebase Admin not initialized');
  return admin.firestore();
}

async function getUserIdByAppUserId(appUserId) {
  if (!appUserId) return null;
  const db = await getFirestore();

  // Try dedicated mapping collection first
  try {
    const q1 = await db.collection('revenuecatSubscriptions').where('app_user_id', '==', appUserId).limit(1).get();
    if (!q1.empty) {
      const d = q1.docs[0].data();
      return d.userId || d.uid || d.user || d.user_id || null;
    }
  } catch (e) {
    // collection might not exist; ignore and continue
  }

  // Fallback: search general subscriptions collection for common field names
  const subsRef = db.collection('subscriptions');
  const fieldCandidates = ['app_user_id', 'revenuecatAppUserId', 'revenuecat_app_user_id', 'revenuecatSubscriptionId', 'revenuecatTransactionId'];
  for (const field of fieldCandidates) {
    try {
      const q = await subsRef.where(field, '==', appUserId).limit(1).get();
      if (!q.empty) {
        const d = q.docs[0].data();
        return d.uid || d.userId || d.user || d.user_id || null;
      }
    } catch (e) {
      // ignore and try next
    }
  }

  return null;
}

async function isEventProcessed(eventId) {
  if (!eventId) return false;
  const db = await getFirestore();
  const doc = await db.collection('webhookEvents').doc(eventId).get();
  return doc.exists;
}

async function markEventProcessed(eventId, meta = {}) {
  if (!eventId) return;
  const db = await getFirestore();
  const admin = require('firebase-admin');
  await db.collection('webhookEvents').doc(eventId).set({ event: eventId, eventName: meta.type || null, processed: true, processedAt: admin.firestore.Timestamp.now(), meta }, { merge: true });
}

async function createSubscriptionFromRevenuecat(purchase) {
  const db = await getFirestore();
  const admin = require('firebase-admin');
  const now = admin.firestore.Timestamp.now();

  // Resolve internal userId. Prefer mapping from RevenueCat `app_user_id` to internal uid.
  let userId = null;
  const appUserId = purchase?.app_user_id || purchase?.appUserId || null;
  if (appUserId) {
    try {
      userId = await getUserIdByAppUserId(appUserId);
    } catch (e) {
      console.error('[revenuecatWebhook.service] failed to lookup user by app_user_id', e);
    }
  }

  // If mapping not found, allow explicit internal user id provided in the payload
  if (!userId) {
    // If there's no mapping, `app_user_id` may already be the internal uid.
    if (appUserId) userId = appUserId;
    else userId = purchase?.userId || purchase?.uid || null;
  }

  if (!userId) {
    console.error('[revenuecatWebhook.service] could not resolve internal userId for purchase', { appUserId, purchase });
  }

  const subscriptionId = purchase?.subscription_id || purchase?.product_id || null;
  const transactionId = purchase?.transaction_id || purchase?.id || null;

  if (!userId) throw new Error('RevenueCat purchase missing user mapping; cannot determine userId');

  const subsRef = db.collection('subscriptions');
  const q = subscriptionId
    ? subsRef.where('revenuecatSubscriptionId', '==', subscriptionId).limit(1)
    : subsRef.where('uid', '==', userId).limit(1);

  let created = null;
  await db.runTransaction(async (tx) => {
    const qSnap = await tx.get(q);
    if (!qSnap.empty) {
      const doc = qSnap.docs[0];
      const data = doc.data();

      const existingEnd = data.endDate ? data.endDate.toDate() : null;
      const nowDate = new Date();
      const updates = {
        status: 'active',
        lastPaymentStatus: 'success',
        retryCount: 0,
        revenuecatTransactionId: transactionId,
        lastProcessedPaymentId: transactionId,
        processor: 'revenuecat',
        updatedAt: now,
      };

      if (!data.startDate) updates.startDate = now;
      if (!existingEnd || existingEnd <= nowDate) {
        const newEnd = new Date(Date.now() + 30 * DAY_MS);
        updates.endDate = admin.firestore.Timestamp.fromDate(newEnd);
      }

      tx.update(doc.ref, updates);
      created = { id: doc.id, ...data, ...updates };
    } else {
      const startDate = now;
      const endDate = admin.firestore.Timestamp.fromDate(new Date(Date.now() + 30 * DAY_MS));
      const payload = {
        uid: userId,
        status: 'active',
        revenuecatTransactionId: transactionId || null,
        revenuecatSubscriptionId: subscriptionId || null,
        processor: 'revenuecat',
        amount: purchase?.price || null,
        startDate,
        endDate,
        lastPaymentStatus: 'success',
        retryCount: 0,
        lastProcessedPaymentId: transactionId || null,
        updatedAt: now,
      };
      const ref = subsRef.doc();
      tx.set(ref, payload);
      created = { id: ref.id, ...payload };
    }

    try {
      tx.set(db.collection('users').doc(String(userId)), { isSubscribed: true, updatedAt: now }, { merge: true });
    } catch (e) {
      console.error('[revenuecatWebhook.service] transaction: failed to update user isSubscribed', e);
    }
  });

  return created;
}

async function extendSubscriptionByUserId(userId, days = 30, processorId = null) {
  if (!userId) throw new Error('Missing userId');
  const db = await getFirestore();
  const admin = require('firebase-admin');
  const subsRef = db.collection('subscriptions');
  const q = subsRef.where('uid', '==', userId);
  const addMs = days * DAY_MS;

  const now = admin.firestore.Timestamp.now();
  let anyUpdated = false;
  await db.runTransaction(async (tx) => {
    const qSnap = await tx.get(q);
    if (qSnap.empty) return null;

    qSnap.forEach((doc) => {
      const data = doc.data();
      const currentEnd = data.endDate ? data.endDate.toDate() : new Date();
      const base = currentEnd < new Date() ? new Date() : currentEnd;
      const newEnd = new Date(base.getTime() + addMs);

      const updates = {
        endDate: admin.firestore.Timestamp.fromDate(newEnd),
        updatedAt: now,
        status: 'active',
        lastPaymentStatus: 'success',
        retryCount: 0,
        processor: 'revenuecat',
      };
      if (processorId) updates.lastProcessedPaymentId = processorId;

      tx.update(doc.ref, updates);
      anyUpdated = true;
    });

    tx.set(db.collection('users').doc(String(userId)), { isSubscribed: true, updatedAt: now }, { merge: true });
  });

  return anyUpdated;
}

async function cancelSubscriptionsByRevenuecatSubscriptionId(revSubId) {
  if (!revSubId) return false;
  const db = await getFirestore();
  const admin = require('firebase-admin');
  const now = admin.firestore.Timestamp.now();
  const q = await db.collection('subscriptions').where('revenuecatSubscriptionId', '==', revSubId).get();
  const ops = [];
  q.forEach((doc) => ops.push(doc.ref.update({ status: 'cancelled', updatedAt: now })));
  await Promise.all(ops);
  return true;
}

/**
 * Main handler for RevenueCat events. This implementation is intentionally
 * permissive because RevenueCat event payload structures may vary by event.
 */
async function handleEvent(event) {
  if (!event) throw new Error('Invalid event object');
  const type = (event.type || event.event || (event?.data && event.data.type) || '').toString();
  const payload = event.data || event.payload || event || {};

  // Resolve a robust event id from several possible locations
  const eventId = event?.event_id || event?.id || event?.data?.id || payload?.id || payload?.transaction_id || payload?.original_transaction_id || null;
  console.log('[revenuecatWebhook.service] handling event', type, eventId || '(no id)');

  // Try to handle common cases: initial purchase, renewal, cancellation
  try {
    // Flat TEST events or payloads that include top-level purchase fields (e.g. product_id + app_user_id)
    if (type === 'TEST' || (payload?.product_id && (payload?.app_user_id || event?.app_user_id))) {
      const purchase = payload || event || {};
      const res = await createSubscriptionFromRevenuecat(purchase);
      console.log('[revenuecatWebhook.service] test/flat purchase processed', { eventId, userId: purchase?.app_user_id || null });
      return res;
    }

    // Initial purchase or one-off purchase: try to create subscription when purchase object exists
    if (/initial_purchase|INITIAL_PURCHASE|INITIAL_PURCHASE_EVENT|INITIAL_PURCHASED|FIRST_PURCHASE/i.test(type) || payload?.purchase) {
      const purchase = payload?.purchase || payload?.transaction || payload || {};
      const res = await createSubscriptionFromRevenuecat(purchase);
      console.log('[revenuecatWebhook.service] initial purchase processed', { eventId, userId: purchase?.app_user_id || null });
      return res;
    }

    // Renewal or subscription renewed: extend by 30 days
    if (/renewal|RENEWAL|SUBSCRIPTION_RENEWED|RENEWED/i.test(type) || payload?.renewal) {
      const appUserId = event?.app_user_id || payload?.app_user_id || payload?.subscriber?.app_user_id || null;
      const processorId = payload?.transaction?.id || payload?.transaction_id || payload?.purchase?.id || null;
      if (appUserId) {
        const uid = await getUserIdByAppUserId(appUserId);
        if (uid) {
          const ok = await extendSubscriptionByUserId(uid, 30, processorId);
          console.log('[revenuecatWebhook.service] renewal processed', { eventId, appUserId, uid, skipped: !ok });
          return ok;
        }
      }
      throw new Error('renewal event missing app_user_id or mapping');
    }

    // Cancellation
    if (/cancel|CANCEL|CANCELLATION|UNSUBSCRIBED/i.test(type) || payload?.cancellation) {
      const revSubId = payload?.subscription_id || payload?.revenuecat_subscription_id || payload?.product_id || null;
      if (revSubId) {
        const ok = await cancelSubscriptionsByRevenuecatSubscriptionId(revSubId);
        console.log('[revenuecatWebhook.service] cancellation processed', { eventId, revSubId, skipped: !ok });
        return ok;
      }

      const appUserId = event?.app_user_id || payload?.app_user_id || payload?.subscriber?.app_user_id || null;
      if (appUserId) {
        const uid = await getUserIdByAppUserId(appUserId);
        if (uid) {
          const db = await getFirestore();
          const admin = require('firebase-admin');
          const now = admin.firestore.Timestamp.now();
          const q = await db.collection('subscriptions').where('uid', '==', uid).get();
          const ops = [];
          q.forEach((doc) => ops.push(doc.ref.update({ status: 'cancelled', updatedAt: now })));
          await Promise.all(ops);
          console.log('[revenuecatWebhook.service] cancellation processed by user', { eventId, uid });
          return true;
        }
      }

      throw new Error('cancellation event missing identifiers');
    }

    console.log('[revenuecatWebhook.service] unhandled event type', type);
    return null;
  } catch (e) {
    console.error('[revenuecatWebhook.service] error handling event', e);
    throw e;
  }
}

module.exports = {
  isEventProcessed,
  markEventProcessed,
  handleEvent,
};
