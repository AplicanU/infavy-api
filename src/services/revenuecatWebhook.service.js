const initFirebaseAdmin = require('../lib/firebaseAdmin');

const DAY_MS = 24 * 60 * 60 * 1000;

const STATUS_PRIORITY = {
  active: 1,
  cancelled: 2,
  inactive: 3,
};

// ---------------- HELPERS ----------------

function ts(ms) {
  const admin = initFirebaseAdmin();
  if (!ms) return null;

  let n = Number(ms);
  if (n < 1e11) n *= 1000;

  return admin.firestore.Timestamp.fromDate(new Date(n));
}

function resolveStatus(current, incoming, endDate) {
  const now = new Date();

  if (incoming === 'inactive') return 'inactive';
  if (incoming === 'cancelled') return 'cancelled';

  if (incoming === 'active') {
    if (current === 'cancelled' && endDate && endDate > now) {
      return 'cancelled';
    }
    return 'active';
  }

  return current || 'active';
}

function applyPriority(current, next) {
  if (!current) return next;
  return STATUS_PRIORITY[current] > STATUS_PRIORITY[next]
    ? current
    : next;
}

// ---------------- DB ----------------

async function getDB() {
  return initFirebaseAdmin().firestore();
}

// ---------------- ACTIVITY LOG (FINAL SCHEMA) ----------------

async function logSubscriptionActivity(event) {
  try {
    const db = await getDB();
    const admin = require('firebase-admin');

    const uid =
      event.app_user_id ||
      (event.aliases && event.aliases[1]) ||
      null;

    await db.collection('subscriptionActivity').add({
      eventId: event.id || null,
      eventType: event.type || null,
      uid: uid,
      rawInput: event,
      time: admin.firestore.Timestamp.now(),
    });
  } catch (e) {
    console.warn('[subscriptionActivity] log failed:', e.message);
  }
}

// ---------------- IDEMPOTENCY ----------------

async function isEventProcessed(eventId) {
  if (!eventId) return false;

  const db = await getDB();
  const doc = await db.collection('webhookEvents').doc(eventId).get();
  return doc.exists;
}

async function markEventProcessed(eventId, type) {
  if (!eventId) return;

  const db = await getDB();
  const admin = require('firebase-admin');

  await db.collection('webhookEvents').doc(eventId).set(
    {
      processed: true,
      type,
      processedAt: admin.firestore.Timestamp.now(),
    },
    { merge: true }
  );
}

// ---------------- USER FLAG ----------------

async function updateUser(uid, status, endDate) {
  const db = await getDB();
  const admin = require('firebase-admin');

  const now = new Date();

  const isSubscribed =
    status === 'active' ||
    (status === 'cancelled' &&
      endDate &&
      endDate.toDate() > now);

  await db.collection('users').doc(String(uid)).set(
    {
      isSubscribed,
      updatedAt: admin.firestore.Timestamp.now(),
    },
    { merge: true }
  );
}

// ---------------- CORE UPSERT ----------------

async function upsertSubscription(event, incomingStatus) {
  const db = await getDB();
  const admin = require('firebase-admin');

  const uid =
    event.app_user_id ||
    (event.aliases && event.aliases[1]) ||
    null;

  // Prefer `product_id` for RevenueCat subscription identifier, fall back to original_transaction_id
  const subscriptionId = event.product_id || event.original_transaction_id; // ✅ critical
  const transactionId = event.transaction_id;

  const startDate =
    ts(event.purchased_at_ms) ||
    admin.firestore.Timestamp.now();

  const endDate =
    ts(event.expiration_at_ms) ||
    admin.firestore.Timestamp.fromDate(
      new Date(Date.now() + 30 * DAY_MS)
    );

  const ref = db.collection('subscriptions');

  const q = await ref
    .where('revenuecatSubscriptionId', '==', subscriptionId)
    .limit(1)
    .get();

  if (!q.empty) {
    const doc = q.docs[0];
    const data = doc.data();

    // Idempotency (transaction level)
    if (data.lastProcessedPaymentId === transactionId) {
      return data;
    }

    let newStatus = resolveStatus(
      data.status,
      incomingStatus,
      data.endDate?.toDate?.()
    );

    newStatus = applyPriority(data.status, newStatus);

    const updates = {
      status: newStatus,
      revenuecatSubscriptionId: subscriptionId,
      revenuecatTransactionId: transactionId,
      lastProcessedPaymentId: transactionId,

      lastPaymentStatus:
        newStatus === 'inactive'
          ? 'expired'
          : newStatus === 'cancelled'
          ? 'cancelled'
          : 'success',

      startDate,
      endDate,

      amount: event.price || null,
      currency: event.currency || null,
      renewalNumber: event.renewal_number || null,
      environment: event.environment || null,

      processor: 'revenuecat',
      retryCount: 0,
      updatedAt: admin.firestore.Timestamp.now(),
    };

    await doc.ref.update(updates);

    await updateUser(uid, newStatus, endDate);

    return updates;
  }

  // CREATE
  const payload = {
    uid,
    status: incomingStatus,
    revenuecatSubscriptionId: subscriptionId,
    revenuecatTransactionId: transactionId,
    lastProcessedPaymentId: transactionId,

    startDate,
    endDate,

    amount: event.price || null,
    currency: event.currency || null,
    renewalNumber: event.renewal_number || null,
    environment: event.environment || null,

    processor: 'revenuecat',
    lastPaymentStatus: 'success',
    retryCount: 0,
    updatedAt: admin.firestore.Timestamp.now(),
  };

  const newRef = await ref.add(payload);

  await updateUser(uid, incomingStatus, endDate);

  return { id: newRef.id, ...payload };
}

// ---------------- MAIN HANDLER ----------------

async function handleEvent(body) {
  if (!body?.event) {
    throw new Error('Invalid RevenueCat webhook format');
  }

  const e = body.event;

  // ✅ ALWAYS LOG FIRST (your required schema)
  await logSubscriptionActivity(e);

  // ✅ Idempotency (event level)
  if (await isEventProcessed(e.id)) {
    console.log('Duplicate event skipped:', e.id);
    return { skipped: true };
  }

  console.log('[RC EVENT]', e.type, e.id);

  let result = null;

  switch (e.type) {
    case 'INITIAL_PURCHASE':
      result = await upsertSubscription(e, 'active');
      break;

    case 'RENEWAL':
      result = await upsertSubscription(e, 'active');
      break;

    case 'PRODUCT_CHANGE':
    case 'UNCANCELLATION':
      result = await upsertSubscription(e, 'active');
      break;

    case 'CANCELLATION':
      result = await upsertSubscription(e, 'cancelled');
      break;

    case 'EXPIRATION':
      result = await upsertSubscription(e, 'inactive');
      break;

    case 'BILLING_ISSUE': {
      const db = await getDB();

      const q = await db
        .collection('subscriptions')
        .where(
          'revenuecatSubscriptionId',
          '==',
          e.product_id || e.original_transaction_id
        )
        .get();

      q.forEach(async (doc) => {
        const d = doc.data();
        await doc.ref.update({
          lastPaymentStatus: 'retrying',
          retryCount: (d.retryCount || 0) + 1,
        });
      });

      result = true;
      break;
    }

    default:
      console.log('Unhandled RC event:', e.type);
      result = null;
  }

  // ✅ mark processed
  await markEventProcessed(e.id, e.type);

  return result;
}

module.exports = {
  handleEvent,
};