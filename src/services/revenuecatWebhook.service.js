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
    if (current === 'cancelled' && endDate > now) {
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

async function db() {
  return initFirebaseAdmin().firestore();
}

async function updateUser(uid, status, endDate) {
  const firestore = await db();
  const admin = require('firebase-admin');

  const now = new Date();

  const isSubscribed =
    status === 'active' ||
    (status === 'cancelled' && endDate?.toDate() > now);

  await firestore.collection('users').doc(uid).set(
    {
      isSubscribed,
      updatedAt: admin.firestore.Timestamp.now(),
    },
    { merge: true }
  );
}

// ---------------- CORE ----------------

async function upsert(rcEvent, incomingStatus) {
  const firestore = await db();
  const admin = require('firebase-admin');

  const {
    app_user_id,
    product_id,
    transaction_id,
    original_transaction_id,
    purchased_at_ms,
    expiration_at_ms,
    price,
    currency,
    renewal_number,
    environment,
  } = rcEvent;

  const uid = app_user_id;

  // ✅ CRITICAL FIX
  const subscriptionId = original_transaction_id;

  const startDate =
    ts(purchased_at_ms) || admin.firestore.Timestamp.now();

  const endDate =
    ts(expiration_at_ms) ||
    admin.firestore.Timestamp.fromDate(
      new Date(Date.now() + 30 * DAY_MS)
    );

  const ref = firestore.collection('subscriptions');

  const q = await ref
    .where('revenuecatSubscriptionId', '==', subscriptionId)
    .limit(1)
    .get();

  if (!q.empty) {
    const doc = q.docs[0];
    const data = doc.data();

    // Idempotency
    if (data.lastProcessedPaymentId === transaction_id) {
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
      revenuecatTransactionId: transaction_id,
      revenuecatSubscriptionId: subscriptionId,
      lastProcessedPaymentId: transaction_id,
      lastPaymentStatus:
        newStatus === 'inactive'
          ? 'expired'
          : newStatus === 'cancelled'
          ? 'cancelled'
          : 'success',
      startDate,
      endDate,
      amount: price,
      currency,
      renewalNumber: renewal_number,
      environment,
      processor: 'revenuecat',
      updatedAt: admin.firestore.Timestamp.now(),
      retryCount: 0,
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
    revenuecatTransactionId: transaction_id,
    lastProcessedPaymentId: transaction_id,
    startDate,
    endDate,
    amount: price,
    currency,
    renewalNumber: renewal_number,
    environment,
    processor: 'revenuecat',
    lastPaymentStatus: 'success',
    retryCount: 0,
    updatedAt: admin.firestore.Timestamp.now(),
  };

  const newRef = await ref.add(payload);

  await updateUser(uid, incomingStatus, endDate);

  return { id: newRef.id, ...payload };
}

// ---------------- HANDLER ----------------

async function handleEvent(body) {
  if (!body?.event) {
    throw new Error('Invalid RevenueCat webhook');
  }

  const e = body.event;

  console.log('[RC EVENT]', e.type, e.id);

  switch (e.type) {
    case 'INITIAL_PURCHASE':
      return upsert(e, 'active');

    case 'RENEWAL':
      return upsert(e, 'active');

    case 'PRODUCT_CHANGE':
      return upsert(e, 'active');

    case 'UNCANCELLATION':
      return upsert(e, 'active');

    case 'CANCELLATION':
      return upsert(e, 'cancelled');

    case 'EXPIRATION':
      return upsert(e, 'inactive');

    case 'BILLING_ISSUE': {
      const firestore = await db();

      const q = await firestore
        .collection('subscriptions')
        .where(
          'revenuecatSubscriptionId',
          '==',
          e.original_transaction_id
        )
        .get();

      q.forEach(async (doc) => {
        const d = doc.data();
        await doc.ref.update({
          lastPaymentStatus: 'retrying',
          retryCount: (d.retryCount || 0) + 1,
        });
      });

      return true;
    }

    default:
      console.log('Unhandled RC event:', e.type);
      return null;
  }
}

module.exports = { handleEvent };