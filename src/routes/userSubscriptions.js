const express = require('express');
const initFirebaseAdmin = require('../lib/firebaseAdmin');

const router = express.Router();

/**
 * Verify webhook (recommended)
 */
const verifyWebhook = (req) => {
  const authHeader = req.headers['authorization'];
  const expected = process.env.REVENUECAT_WEBHOOK_SECRET;
  if (!expected) return true;
  return authHeader === expected;
};

/**
 * Map RevenueCat event → subscription status
 */
const mapEventToStatus = (type) => {
  switch (type) {
    case 'INITIAL_PURCHASE':
    case 'RENEWAL':
    case 'UNCANCELLATION':
      return 'active';

    case 'CANCELLATION':
      return 'cancelled';

    case 'EXPIRATION':
      return 'inactive';

    case 'BILLING_ISSUE':
      return 'active'; // still active during retry period

    default:
      return null;
  }
};

/**
 * Map payment status
 */
const mapPaymentStatus = (type) => {
  switch (type) {
    case 'INITIAL_PURCHASE':
    case 'RENEWAL':
      return 'success';

    case 'BILLING_ISSUE':
      return 'failed';

    case 'EXPIRATION':
      return 'expired';

    default:
      return 'success';
  }
};

/**
 * Access logic
 */
const hasAccess = (status) => {
  return status === 'active' || status === 'cancelled';
};


// POST /webhook/revenuecat
router.post('/revenuecat', async (req, res) => {
  const admin = initFirebaseAdmin();
  if (!admin) return res.status(500).send('Firebase not initialized');

  try {
    if (!verifyWebhook(req)) {
      return res.status(401).send('Unauthorized');
    }

    const event = req.body?.event;
    if (!event) return res.status(400).send('Missing event');

    const {
      id: eventId,
      type,
      app_user_id: uid,
      product_id,
      original_transaction_id,
      transaction_id,
      expiration_at_ms,
      purchased_at_ms,
      price_in_purchased_currency,
    } = event;

    if (!uid) return res.status(400).send('Missing uid');

    const db = admin.firestore();

    /**
     * Idempotency check
     */
    const eventRef = db.collection('webhookEvents').doc(eventId);
    const existing = await eventRef.get();

    if (existing.exists) {
      return res.status(200).send('Already processed');
    }

    /**
     * Fetch subscription
     */
    const snap = await db
      .collection('subscriptions')
      .where('uid', '==', uid)
      .limit(1)
      .get();

    let subRef;
    let existingData = {};

    if (snap.empty) {
      subRef = db.collection('subscriptions').doc();
    } else {
      subRef = snap.docs[0].ref;
      existingData = snap.docs[0].data();
    }

    /**
     * Compute status + payment state
     */
    const newStatus = mapEventToStatus(type);
    const paymentStatus = mapPaymentStatus(type);

    /**
     * Retry logic
     */
    let retryCount = existingData.retryCount || 0;

    if (type === 'BILLING_ISSUE') {
      retryCount += 1;
    } else if (type === 'RENEWAL' || type === 'INITIAL_PURCHASE') {
      retryCount = 0;
    }

    /**
     * Build update (aligned with your schema)
     */
    const update = {
      uid,
      processor: 'revenuecat',

      revenuecatSubscriptionId: original_transaction_id,
      revenuecatTransactionId: transaction_id,
      lastProcessedPaymentId: transaction_id,

      lastPaymentStatus: paymentStatus,
      retryCount,

      updatedAt: admin.firestore.Timestamp.now(),
    };

    if (price_in_purchased_currency != null) {
      update.amount = price_in_purchased_currency;
    }

    if (purchased_at_ms) {
      update.startDate = admin.firestore.Timestamp.fromMillis(purchased_at_ms);
    }

    if (expiration_at_ms) {
      update.endDate = admin.firestore.Timestamp.fromMillis(expiration_at_ms);
    }

    if (newStatus) {
      update.status = newStatus;
    }

    /**
     * Write to Firestore
     */
    await subRef.set(update, { merge: true });

    /**
     * Final status for access
     */
    const finalStatus = newStatus || existingData.status || 'active';

    /**
     * Sync users collection
     */
    await db.collection('users').doc(uid).set(
      {
        isSubscribed: hasAccess(finalStatus),
        subscriptionStatus: finalStatus,
        updatedAt: admin.firestore.Timestamp.now(),
      },
      { merge: true }
    );

    /**
     * Activity log
     */
    await db.collection('subscriptionActivity').add({
      uid,
      type,
      eventId,
      status: finalStatus,
      paymentStatus,
      transactionId: transaction_id,
      time: admin.firestore.Timestamp.now(),
    });

    /**
     * Mark processed
     */
    await eventRef.set({
      uid,
      type,
      processedAt: admin.firestore.Timestamp.now(),
    });

    return res.status(200).send('OK');

  } catch (err) {
    console.error('[Webhook Error]', err);
    return res.status(500).send('Internal Server Error');
  }
});

module.exports = router;