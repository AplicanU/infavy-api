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

/**
 * Try to resolve a Firebase userId from a Razorpay customer id.
 * Looks first in a dedicated `razorpaySubscriptions` collection, then
 * falls back to `subscriptions` collection fields that may store the customer id.
 */
async function getUserIdByCustomerId(customerId) {
  if (!customerId) return null;
  const db = await getFirestore();

  // Try dedicated mapping collection first
  try {
    const q1 = await db.collection('razorpaySubscriptions').where('customer_id', '==', customerId).limit(1).get();
    if (!q1.empty) {
      const d = q1.docs[0].data();
      return d.userId || d.uid || d.user || d.user_id || null;
    }
  } catch (e) {
    // collection might not exist; ignore and continue
  }

  // Fallback: search general subscriptions collection for common field names
  const subsRef = db.collection('subscriptions');
  const fieldCandidates = ['customer_id', 'customerId', 'razorpayCustomerId', 'razorpay_customer_id'];
  for (const field of fieldCandidates) {
    try {
      const q = await subsRef.where(field, '==', customerId).limit(1).get();
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
  // Consider processed if a record exists
  return doc.exists;
}

async function markEventProcessed(eventId, meta = {}) {
  if (!eventId) return;
  const db = await getFirestore();
  const admin = require('firebase-admin');
  await db.collection('webhookEvents').doc(eventId).set({ event: eventId, eventName: meta.type || null, processed: true, processedAt: admin.firestore.Timestamp.now(), meta }, { merge: true });
}

async function createSubscriptionFromPayment(payment) {
  const db = await getFirestore();
  const admin = require('firebase-admin');
  const now = admin.firestore.Timestamp.now();

  let userId = payment?.notes?.userId || payment?.notes?.userID || payment?.notes?.user || null;
  // If frontend didn't attach userId in notes, try resolving via Razorpay customer id
  if (!userId) {
    const customerId = payment?.customer_id || payment?.customer || null;
    if (customerId) {
      try {
        userId = await getUserIdByCustomerId(customerId);
      } catch (e) {
        console.error('[razorpayWebhook.service] failed to lookup user by customerId', e);
      }
    }
  }
  const subscriptionId = payment?.notes?.subscriptionId || payment?.notes?.subscription_id || null;
  const paymentId = payment?.id || null;

  if (!userId) throw new Error('payment.captured missing userId in payment.notes and could not resolve via customer_id');

  // Transactionally create or update subscription
  const subsRef = db.collection('subscriptions');
  const q = subscriptionId
    ? subsRef.where('razorpaySubscriptionId', '==', subscriptionId).limit(1)
    : subsRef.where('uid', '==', userId).limit(1);

  let created = null;
  await db.runTransaction(async (tx) => {
    const qSnap = await tx.get(q);
    if (!qSnap.empty) {
      const doc = qSnap.docs[0];
      const data = doc.data();

      // Do not overwrite endDate if already valid (> now)
      const existingEnd = data.endDate ? data.endDate.toDate() : null;
      const nowDate = new Date();
      const updates = {
        status: 'active',
        lastPaymentStatus: 'success',
        retryCount: 0,
        razorpayPaymentId: paymentId,
        lastProcessedPaymentId: paymentId,
        updatedAt: now,
      };

      if (!data.startDate) updates.startDate = now;
      if (!existingEnd || existingEnd <= nowDate) {
        // set endDate to now + 30 days
        const newEnd = new Date(Date.now() + 30 * DAY_MS);
        updates.endDate = admin.firestore.Timestamp.fromDate(newEnd);
      }

      tx.update(doc.ref, updates);
      created = { id: doc.id, ...data, ...updates };
    } else {
      // create new subscription
      const startDate = now;
      const endDate = admin.firestore.Timestamp.fromDate(new Date(Date.now() + 30 * DAY_MS));
      const payload = {
        uid: userId,
        status: 'active',
        razorpayPaymentId: paymentId,
        razorpaySubscriptionId: subscriptionId || null,
        amount: payment.amount || null,
        startDate,
        endDate,
        lastPaymentStatus: 'success',
        retryCount: 0,
        lastProcessedPaymentId: paymentId,
        updatedAt: now,
      };
      const ref = subsRef.doc();
      tx.set(ref, payload);
      created = { id: ref.id, ...payload };
    }

    // mark user as subscribed
    try {
      tx.set(db.collection('users').doc(String(userId)), { isSubscribed: true, updatedAt: now }, { merge: true });
    } catch (e) {
      console.error('[razorpayWebhook.service] transaction: failed to update user isSubscribed', e);
    }
  });

  return created;
}

async function extendSubscriptionBySubscriptionId(razorpaySubscriptionId, days = 30, processorId = null) {
  if (!razorpaySubscriptionId) throw new Error('Missing razorpaySubscriptionId');
  const db = await getFirestore();
  const admin = require('firebase-admin');

  const subsRef = db.collection('subscriptions');
  const q = subsRef.where('razorpaySubscriptionId', '==', razorpaySubscriptionId);
  const addMs = days * DAY_MS;

  // Use transaction to avoid duplicate extensions and ensure atomic updates
  const now = admin.firestore.Timestamp.now();
  let anyUpdated = false;
  await db.runTransaction(async (tx) => {
    const qSnap = await tx.get(q);
    if (qSnap.empty) return null;

    const userUpdates = [];
    qSnap.forEach((doc) => {
      const data = doc.data();
      // Prevent duplicate processing if processorId matches lastProcessedPaymentId
      if (processorId && data.lastProcessedPaymentId && data.lastProcessedPaymentId === processorId) {
        console.log('[razorpayWebhook.service] skipping duplicate processorId for subscription', doc.id);
        return;
      }

      const currentEnd = data.endDate ? data.endDate.toDate() : new Date();
      const base = currentEnd < new Date() ? new Date() : currentEnd;
      const newEnd = new Date(base.getTime() + addMs);

      const updates = {
        endDate: admin.firestore.Timestamp.fromDate(newEnd),
        updatedAt: now,
        status: 'active',
        lastPaymentStatus: 'success',
        retryCount: 0,
      };
      if (processorId) updates.lastProcessedPaymentId = processorId;

      tx.update(doc.ref, updates);
      userUpdates.push(tx.set(db.collection('users').doc(String(data.uid)), { isSubscribed: true, updatedAt: now }, { merge: true }));
      anyUpdated = true;
    });

    // await user updates
    await Promise.all(userUpdates);
  });

  return anyUpdated;
}

async function extendSubscriptionByUserId(userId, days = 30) {
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
      };

      tx.update(doc.ref, updates);
      anyUpdated = true;
    });

    tx.set(db.collection('users').doc(String(userId)), { isSubscribed: true, updatedAt: now }, { merge: true });
  });

  return anyUpdated;
}

async function markSubscriptionsPaymentFailedForUser(userId) {
  if (!userId) throw new Error('Missing userId');
  const db = await getFirestore();
  const admin = require('firebase-admin');
  const q = db.collection('subscriptions').where('uid', '==', userId);
  const now = admin.firestore.Timestamp.now();

  await db.runTransaction(async (tx) => {
    const qSnap = await tx.get(q);
    if (qSnap.empty) return null;

    qSnap.forEach((doc) => {
      const data = doc.data();
      const newRetry = (data.retryCount || 0) + 1;
      tx.update(doc.ref, { status: 'past_due', lastPaymentStatus: 'failed', retryCount: newRetry, updatedAt: now });
    });

    tx.set(db.collection('users').doc(String(userId)), { isSubscribed: false, updatedAt: now }, { merge: true });
  });

  return true;
}

/**
 * Main event handler. Expects the verified and parsed event object from Razorpay.
 * Implements idempotency checks externally (caller should call isEventProcessed first)
 */
async function handleEvent(event) {
  if (!event || !event.event) throw new Error('Invalid event object');
  const type = event.event;
  const payload = event.payload || {};

  console.log('[razorpayWebhook.service] handling event', type, event.id || '(no id)');

  switch (type) {
    case 'payment.captured': {
      // payload.payment.entity
      const payment = payload.payment && payload.payment.entity ? payload.payment.entity : payload.payment || {};
      const result = await createSubscriptionFromPayment(payment);
      console.log('[razorpayWebhook.service] payment.captured processed', { eventId: event.id, userId: payment?.notes?.userId || null, paymentId: payment?.id });
      return result;
    }

    case 'invoice.paid': {
      const invoice = payload.invoice && payload.invoice.entity ? payload.invoice.entity : payload.invoice || {};
      const subId = invoice.subscription_id || invoice.subscriptionId || null;
      const userId = invoice?.notes?.userId || invoice?.notes?.userID || null;
      const processorId = invoice.id || invoice.payment_id || invoice.invoice_id || null;
      if (subId) {
        const ok = await extendSubscriptionBySubscriptionId(subId, 30, processorId);
        console.log('[razorpayWebhook.service] invoice.paid processed', { eventId: event.id, userId, subId, skipped: !ok });
        return ok;
      }
      if (userId) {
        const ok = await extendSubscriptionByUserId(userId, 30);
        console.log('[razorpayWebhook.service] invoice.paid processed by userId', { eventId: event.id, userId, skipped: !ok });
        return ok;
      }
      throw new Error('invoice.paid missing subscription_id and notes.userId');
    }

    case 'subscription.activated': {
      const subscription = payload.subscription && payload.subscription.entity ? payload.subscription.entity : payload.subscription || {};
      const subId = subscription.id || subscription.subscription_id || null;
      const userId = subscription?.notes?.userId || subscription?.notes?.userID || null;
      if (!subId && !userId) throw new Error('subscription.activated missing identifiers');
      // If we have subscription id, extend by 30, else try via user
      if (subId) {
        const ok = await extendSubscriptionBySubscriptionId(subId, 30, subscription?.id || null);
        console.log('[razorpayWebhook.service] subscription.activated', { eventId: event.id, userId, subId, skipped: !ok });
        return ok;
      }
      const ok = await extendSubscriptionByUserId(userId, 30);
      console.log('[razorpayWebhook.service] subscription.activated by user', { eventId: event.id, userId, skipped: !ok });
      return ok;
    }

    case 'subscription.charged': {
      const subscription = payload.subscription && payload.subscription.entity ? payload.subscription.entity : payload.subscription || {};
      const subId = subscription.id || subscription.subscription_id || null;
      const userId = subscription?.notes?.userId || subscription?.notes?.userID || null;
      // Try to extract unique processor id to prevent duplicate extensions
      const processorId = payload?.payment && payload.payment.entity ? payload.payment.entity.id : (payload?.invoice && payload.invoice.entity ? payload.invoice.entity.id : null);
      if (subId) {
        const ok = await extendSubscriptionBySubscriptionId(subId, 30, processorId);
        console.log('[razorpayWebhook.service] subscription.charged', { eventId: event.id, userId, subId, skipped: !ok });
        return ok;
      }
      if (userId) {
        const ok = await extendSubscriptionByUserId(userId, 30);
        console.log('[razorpayWebhook.service] subscription.charged by user', { eventId: event.id, userId, skipped: !ok });
        return ok;
      }
      throw new Error('subscription.charged missing identifiers');
    }

    case 'payment.failed': {
      const payment = payload.payment && payload.payment.entity ? payload.payment.entity : payload.payment || {};
      let userId = payment?.notes?.userId || payment?.notes?.userID || null;
      if (!userId) {
        const customerId = payment?.customer_id || payment?.customer || null;
        if (customerId) {
          try {
            userId = await getUserIdByCustomerId(customerId);
          } catch (e) {
            console.error('[razorpayWebhook.service] failed to lookup user by customerId for payment.failed', e);
          }
        }
      }
      if (!userId) throw new Error('payment.failed missing userId in payment.notes and could not resolve via customer_id');
      const result = await markSubscriptionsPaymentFailedForUser(userId);
      console.log('[razorpayWebhook.service] payment.failed processed', { eventId: event.id, userId, paymentId: payment?.id });
      return result;
    }

    case 'subscription.halted': {
      const subscription = payload.subscription && payload.subscription.entity ? payload.subscription.entity : payload.subscription || {};
      const subId = subscription.id || subscription.subscription_id || null;
      if (subId) {
        const db = await getFirestore();
        const admin = require('firebase-admin');
        const now = admin.firestore.Timestamp.now();
        const q = await db.collection('subscriptions').where('razorpaySubscriptionId', '==', subId).get();
        const ops = [];
        q.forEach((doc) => ops.push(doc.ref.update({ status: 'halted', updatedAt: now })));
        await Promise.all(ops);
      }
      console.log('[razorpayWebhook.service] subscription.halted', { eventId: event.id, subId: subscription?.id || null });
      return true;
    }

    case 'subscription.cancelled': {
      const subscription = payload.subscription && payload.subscription.entity ? payload.subscription.entity : payload.subscription || {};
      const subId = subscription.id || subscription.subscription_id || null;
      if (subId) {
        const db = await getFirestore();
        const admin = require('firebase-admin');
        const now = admin.firestore.Timestamp.now();
        const q = await db.collection('subscriptions').where('razorpaySubscriptionId', '==', subId).get();
        const ops = [];
        q.forEach((doc) => ops.push(doc.ref.update({ status: 'cancelled', updatedAt: now })));
        await Promise.all(ops);
      }
      console.log('[razorpayWebhook.service] subscription.cancelled', { eventId: event.id, subId: subscription?.id || null });
      return true;
    }

    default:
      console.log('[razorpayWebhook.service] unhandled event type', type);
      return null;
  }
}

module.exports = {
  isEventProcessed,
  markEventProcessed,
  handleEvent,
};
