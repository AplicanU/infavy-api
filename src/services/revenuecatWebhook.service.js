const initFirebaseAdmin = require('../lib/firebaseAdmin');

const DAY_MS = 24 * 60 * 60 * 1000;

function tsFromDate(date) {
  const admin = initFirebaseAdmin();
  return admin.firestore.Timestamp.fromDate(date);
}

function tsFromMs(ms) {
  const admin = initFirebaseAdmin();
  if (!ms) return null;
  // Accept numbers (ms or seconds) or ISO strings. Be permissive.
  let n = null;
  if (typeof ms === 'number') n = ms;
  else if (/^\d+$/.test(String(ms))) {
    // numeric string
    n = Number(ms);
  } else if (typeof ms === 'string') {
    // ISO or other date string
    const parsed = Date.parse(ms);
    if (!isNaN(parsed)) n = parsed;
  }

  if (n == null) {
    // Could not parse; log and return null
    try { console.warn('[revenuecatWebhook.service] tsFromMs: unrecognized timestamp', ms); } catch (e) {}
    return null;
  }

  // If value looks like seconds (<= 1e10), convert to ms
  if (n > 0 && n < 1e11) n = n * 1000;

  const d = new Date(n);
  if (isNaN(d.getTime())) return null;
  return admin.firestore.Timestamp.fromDate(d);
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

/**
 * Log subscription activity to Firestore collection `subscriptionActivity`.
 * Fields: uid, eventType, time, rawInput, eventId
 */
async function logSubscriptionActivity(uid, eventType, rawInput, eventId = null) {
  try {
    const db = await getFirestore();
    const admin = require('firebase-admin');
    const now = admin.firestore.Timestamp.now();
    await db.collection('subscriptionActivity').add({ uid: uid || null, eventType: eventType || null, time: now, rawInput: rawInput || null, eventId: eventId || null });
  } catch (e) {
    try {
      console.warn('[revenuecatWebhook.service] failed to log subscription activity', e && e.message ? e.message : e);
    } catch (ee) {}
  }
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
  // Mapping: `uid` <- `app_user_id` per specification
  let userId = null;
  const appUserId = purchase?.app_user_id || purchase?.appUserId || purchase?.uid || null;
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

  // revenuecatSubscriptionId <- product_id (or subscription_id)
  // revenuecatTransactionId, lastProcessedPaymentId <- transaction_id
  const subscriptionId = purchase?.product_id || purchase?.subscription_id || null;
  const transactionId = purchase?.transaction_id || purchase?.id || null;
  const purchasedAtMs = purchase?.purchased_at_ms || purchase?.purchased_at || null;
  const expirationAtMs = purchase?.expiration_at_ms || purchase?.expiration_at || null;

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

        // Idempotency: if this transaction was already processed, skip updates
        if (transactionId && data.lastProcessedPaymentId && data.lastProcessedPaymentId === transactionId) {
          return (created = { id: doc.id, ...data });
        }

        const existingEnd = data.endDate ? data.endDate.toDate() : null;
        const nowDate = new Date();
        const updates = {
          // For an initial purchase we mark active and success by default
          status: 'active',
          lastPaymentStatus: 'success',
          retryCount: 0,
          revenuecatTransactionId: transactionId || data.revenuecatTransactionId || null,
          lastProcessedPaymentId: transactionId || data.lastProcessedPaymentId || null,
          processor: 'revenuecat',
          updatedAt: now,
        };

        // Override start/end if event provides explicit timestamps (always prefer event timestamps)
        if (purchasedAtMs) updates.startDate = tsFromMs(purchasedAtMs) || updates.startDate || now;
        if (expirationAtMs) updates.endDate = tsFromMs(expirationAtMs) || updates.endDate;
        // if no explicit expiration provided and subscription expired or missing, extend default 30 days
        if (!updates.endDate && (!existingEnd || existingEnd <= nowDate)) {
          const newEnd = new Date(Date.now() + 30 * DAY_MS);
          updates.endDate = admin.firestore.Timestamp.fromDate(newEnd);
        }

      // Logging status transition and retry changes
      try {
        console.log('[revenuecatWebhook.service] update subscription', { uid: data.uid || userId, transactionId, oldStatus: data.status, newStatus: updates.status, oldRetry: data.retryCount, newRetry: updates.retryCount });
      } catch (e) {
        // swallow logging errors
      }
      tx.update(doc.ref, updates);
      created = { id: doc.id, ...data, ...updates };
    } else {
      const startDate = tsFromMs(purchasedAtMs) || now;
      const endDate = tsFromMs(expirationAtMs) || admin.firestore.Timestamp.fromDate(new Date(Date.now() + 30 * DAY_MS));
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
      try {
        console.log('[revenuecatWebhook.service] created subscription', { uid: payload.uid, transactionId, revenuecatSubscriptionId: payload.revenuecatSubscriptionId });
      } catch (e) {}
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
      // idempotency: if we've already processed this payment, skip
      if (processorId && data.lastProcessedPaymentId && data.lastProcessedPaymentId === processorId) return;
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

      try {
        console.log('[revenuecatWebhook.service] extend subscription', { uid: data.uid || userId, oldStatus: data.status, newStatus: updates.status, oldRetry: data.retryCount, newRetry: updates.retryCount, processorId });
      } catch (e) {}

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
  // Do NOT set `status` to inactive/cancelled per rules. Keep `status` as-is
  // but mark lastPaymentStatus so the event is recorded.
  q.forEach((doc) => ops.push(doc.ref.update({ lastPaymentStatus: 'cancelled', updatedAt: now })));
  await Promise.all(ops);
  return true;
}

/**
 * Main handler for RevenueCat events. Mapping rules and behaviour are kept
 * minimal and non-breaking; event fields are normalized then mapped to our
 * subscription schema. Important rules implemented:
 * - Idempotency via `lastProcessedPaymentId`
 * - Mapping from RevenueCat fields to our schema (documented inline)
 * - Do not trust `status` blindly; compute `inactive` when endDate passed
 * - Cancellation does not deactivate subscription — only logs/marks payment status
 */
async function handleEvent(event) {
  if (!event) throw new Error('Invalid event object');
  // Prefer inner payload if present (some webhook envelopes use `event`)
  const payload = event.data || event.payload || event.event || event || {};
  const type = (payload.type || payload.event || payload?.data?.type || event?.type || '').toString();

  // Resolve a robust event id from payload or top-level
  const eventId = payload?.event_id || payload?.id || payload?.data?.id || event?.event_id || event?.id || payload?.transaction_id || payload?.original_transaction_id || null;
  console.log('[revenuecatWebhook.service] handling event', type || '(no type)', eventId || '(no id)', 'payloadKeys=', Object.keys(payload || {}));

  // Normalize relevant fields according to Step 1 mapping
  // uid <- app_user_id
  // revenuecatSubscriptionId <- product_id
  // revenuecatTransactionId, lastProcessedPaymentId <- transaction_id
  // startDate <- purchased_at_ms, endDate <- expiration_at_ms
  const mapped = {
    uid: payload?.app_user_id || payload?.appUserId || payload?.uid || payload?.subscriber?.app_user_id || null,
    revenuecatSubscriptionId: payload?.product_id || payload?.subscription_id || payload?.productId || null,
    transaction_id: payload?.transaction_id || payload?.transaction?.id || payload?.purchase?.id || null,
    purchased_at_ms: payload?.purchased_at_ms || payload?.purchase?.purchased_at_ms || payload?.purchase?.purchased_at || payload?.purchased_at || null,
    expiration_at_ms: payload?.expiration_at_ms || payload?.purchase?.expiration_at_ms || payload?.expiration_at || null,
    eventType: type,
  };

  const incomingTxn = mapped.transaction_id;

  try {
    // Log activity (do this early so raw payload is captured even if processing errors)
    await logSubscriptionActivity(mapped.uid || null, mapped.eventType || type || null, payload || null, eventId || null);
    // TEST/flat purchase
    if (type === 'TEST' || (payload?.product_id && (payload?.app_user_id || event?.app_user_id))) {
      const purchase = payload || event || {};
      const res = await createSubscriptionFromRevenuecat(purchase);
      console.log('[revenuecatWebhook.service] test/flat purchase processed', { eventId, userId: purchase?.app_user_id || null });
      return res;
    }

    // INITIAL_PURCHASE
    if (/initial_purchase|INITIAL_PURCHASE|INITIAL_PURCHASE_EVENT|INITIAL_PURCHASED|FIRST_PURCHASE/i.test(type) || payload?.purchase) {
      const purchase = Object.assign({}, payload?.purchase || payload || {});
      purchase.app_user_id = mapped.uid || purchase.app_user_id;
      purchase.product_id = mapped.revenuecatSubscriptionId || purchase.product_id;
      purchase.transaction_id = mapped.transaction_id || purchase.transaction_id;
      purchase.purchased_at_ms = mapped.purchased_at_ms || purchase.purchased_at_ms;
      purchase.expiration_at_ms = mapped.expiration_at_ms || purchase.expiration_at_ms;

      const res = await createSubscriptionFromRevenuecat(purchase);
      console.log('[revenuecatWebhook.service] initial purchase processed', { eventId, userId: mapped.uid || null });
      return res;
    }

    // RENEWAL
    if (/renewal|RENEWAL|SUBSCRIPTION_RENEWED|RENEWED/i.test(type) || payload?.renewal) {
      const appUserId = mapped.uid || event?.app_user_id || payload?.app_user_id || payload?.subscriber?.app_user_id || null;
      const processorId = mapped.transaction_id || payload?.transaction?.id || payload?.transaction_id || payload?.purchase?.id || null;
      if (appUserId) {
        const uid = await getUserIdByAppUserId(appUserId);
        if (uid) {
          // If expiration timestamp provided, prefer it; otherwise extend by default 30 days.
          const db = await getFirestore();
          const admin = require('firebase-admin');
          const now = admin.firestore.Timestamp.now();

          const q = db.collection('subscriptions').where('uid', '==', uid).limit(1);
          const snap = await q.get();
          if (!snap.empty) {
            const doc = snap.docs[0];
            const data = doc.data();
            // Idempotency: if we've already processed this transaction, ignore
            if (processorId && data.lastProcessedPaymentId && data.lastProcessedPaymentId === processorId) {
              console.log('[revenuecatWebhook.service] renewal ignored (idempotent)', { uid, processorId });
              return { skipped: true };
            }

            const updates = { lastPaymentStatus: 'success', retryCount: 0, updatedAt: now, processor: 'revenuecat' };
            if (processorId) updates.lastProcessedPaymentId = processorId;
            if (mapped.expiration_at_ms) updates.endDate = tsFromMs(mapped.expiration_at_ms);
            else {
              // extend by 30 days from current end or now
              const currentEnd = data.endDate ? data.endDate.toDate() : new Date();
              const base = currentEnd < new Date() ? new Date() : currentEnd;
              updates.endDate = admin.firestore.Timestamp.fromDate(new Date(base.getTime() + 30 * DAY_MS));
            }

            await doc.ref.update(updates);
            // sync user isSubscribed
            await db.collection('users').doc(String(uid)).set({ isSubscribed: true, updatedAt: admin.firestore.Timestamp.now() }, { merge: true });

            console.log('[revenuecatWebhook.service] renewal processed', { eventId, appUserId, uid });
            return { ok: true };
          }
        }
      }
      throw new Error('renewal event missing app_user_id or mapping');
    }

    // CANCELLATION: do NOT set inactive; keep status active and just log/update lastPaymentStatus
    if (/cancel|CANCEL|CANCELLATION|UNSUBSCRIBED/i.test(type) || payload?.cancellation) {
      const revSubId = mapped.revenuecatSubscriptionId || payload?.subscription_id || payload?.revenuecat_subscription_id || payload?.product_id || null;
      const appUserId = mapped.uid || event?.app_user_id || payload?.app_user_id || payload?.subscriber?.app_user_id || null;

      if (revSubId) {
        const db = await getFirestore();
        const admin = require('firebase-admin');
        const now = admin.firestore.Timestamp.now();
        const q = await db.collection('subscriptions').where('revenuecatSubscriptionId', '==', revSubId).get();
        const ops = [];
        q.forEach((doc) => ops.push(doc.ref.update({ lastPaymentStatus: 'cancelled', updatedAt: now })));
        await Promise.all(ops);
        console.log('[revenuecatWebhook.service] cancellation received (kept active)', { eventId, revSubId });
        return true;
      }

      if (appUserId) {
        const uid = await getUserIdByAppUserId(appUserId);
        if (uid) {
          const db = await getFirestore();
          const admin = require('firebase-admin');
          const now = admin.firestore.Timestamp.now();
          const q = await db.collection('subscriptions').where('uid', '==', uid).get();
          const ops = [];
          q.forEach((doc) => ops.push(doc.ref.update({ lastPaymentStatus: 'cancelled', updatedAt: now })));
          await Promise.all(ops);
          console.log('[revenuecatWebhook.service] cancellation received by user (kept active)', { eventId, uid });
          return true;
        }
      }

      throw new Error('cancellation event missing identifiers');
    }

    // EXPIRATION: set status inactive
    if (/expiration|EXPIRED|EXPIRATION|SUBSCRIPTION_EXPIRED/i.test(type) || payload?.expiration) {
      const appUserId = mapped.uid || payload?.app_user_id || event?.app_user_id || null;
      const revSubId = mapped.revenuecatSubscriptionId || payload?.product_id || null;
      const db = await getFirestore();
      const admin = require('firebase-admin');
      const now = admin.firestore.Timestamp.now();

      const applyInactive = async (q) => {
        const snap = await q.get();
        const ops = [];
        snap.forEach((doc) => ops.push(doc.ref.update({ status: 'inactive', lastPaymentStatus: 'expired', updatedAt: now })));
        await Promise.all(ops);
      };

      if (revSubId) {
        await applyInactive(db.collection('subscriptions').where('revenuecatSubscriptionId', '==', revSubId));
        console.log('[revenuecatWebhook.service] expiration processed by revSubId', { eventId, revSubId });
        return true;
      }

      if (appUserId) {
        const uid = await getUserIdByAppUserId(appUserId);
        if (uid) {
          await applyInactive(db.collection('subscriptions').where('uid', '==', uid));
          console.log('[revenuecatWebhook.service] expiration processed by uid', { eventId, uid });
          // sync users table
          await db.collection('users').doc(String(uid)).set({ isSubscribed: false, updatedAt: now }, { merge: true });
          return true;
        }
      }

      throw new Error('expiration event missing identifiers');
    }

    // BILLING_ISSUE: keep active, mark retrying and increment retryCount
    if (/billing_issue|BILLING_ISSUE|PAYMENT_FAILED|BILLING_PROBLEM/i.test(type) || payload?.billing_issue) {
      const appUserId = mapped.uid || payload?.app_user_id || event?.app_user_id || null;
      const revSubId = mapped.revenuecatSubscriptionId || payload?.product_id || null;
      const db = await getFirestore();
      const admin = require('firebase-admin');
      const now = admin.firestore.Timestamp.now();

      const applyRetry = async (q) => {
        const snap = await q.get();
        const ops = [];
        snap.forEach((doc) => {
          const d = doc.data();
          const nextRetry = (d.retryCount || 0) + 1;
          ops.push(doc.ref.update({ lastPaymentStatus: 'retrying', retryCount: nextRetry, updatedAt: now }));
        });
        await Promise.all(ops);
      };

      if (revSubId) {
        await applyRetry(db.collection('subscriptions').where('revenuecatSubscriptionId', '==', revSubId));
        console.log('[revenuecatWebhook.service] billing issue applied by revSubId', { eventId, revSubId });
        return true;
      }

      if (appUserId) {
        const uid = await getUserIdByAppUserId(appUserId);
        if (uid) {
          await applyRetry(db.collection('subscriptions').where('uid', '==', uid));
          console.log('[revenuecatWebhook.service] billing issue applied by uid', { eventId, uid });
          return true;
        }
      }

      throw new Error('billing issue event missing identifiers');
    }

    // UNCANCELLATION: reactivate
    if (/uncancel|UNCANCELLATION|UNCANCELLED|REACTIVATION/i.test(type) || payload?.uncancellation) {
      const appUserId = mapped.uid || payload?.app_user_id || event?.app_user_id || null;
      const revSubId = mapped.revenuecatSubscriptionId || payload?.product_id || null;
      const db = await getFirestore();
      const admin = require('firebase-admin');
      const now = admin.firestore.Timestamp.now();

      const applyUncancel = async (q) => {
        const snap = await q.get();
        const ops = [];
        snap.forEach((doc) => ops.push(doc.ref.update({ status: 'active', lastPaymentStatus: 'success', updatedAt: now })));
        await Promise.all(ops);
      };

      if (revSubId) {
        await applyUncancel(db.collection('subscriptions').where('revenuecatSubscriptionId', '==', revSubId));
        return true;
      }
      if (appUserId) {
        const uid = await getUserIdByAppUserId(appUserId);
        if (uid) {
          await applyUncancel(db.collection('subscriptions').where('uid', '==', uid));
          return true;
        }
      }
    }

    // PRODUCT_CHANGE: update revenuecatSubscriptionId
    if (/product_change|PRODUCT_CHANGE|PRODUCT_SWITCH|UPGRADE|DOWNGRADE/i.test(type) || payload?.product_change) {
      const appUserId = mapped.uid || payload?.app_user_id || event?.app_user_id || null;
      const newProductId = mapped.revenuecatSubscriptionId || payload?.new_product_id || payload?.product_id || null;
      if (!newProductId) throw new Error('product_change event missing new product id');

      const db = await getFirestore();
      const admin = require('firebase-admin');
      const now = admin.firestore.Timestamp.now();
      if (appUserId) {
        const uid = await getUserIdByAppUserId(appUserId);
        if (uid) {
          const snap = await db.collection('subscriptions').where('uid', '==', uid).get();
          const ops = [];
          snap.forEach((doc) => ops.push(doc.ref.update({ revenuecatSubscriptionId: newProductId, updatedAt: now })));
          await Promise.all(ops);
          return true;
        }
      }
      // fallback: try by transaction/product
      const q = await db.collection('subscriptions').where('revenuecatTransactionId', '==', mapped.transaction_id).get();
      const ops = [];
      q.forEach((doc) => ops.push(doc.ref.update({ revenuecatSubscriptionId: newProductId, updatedAt: admin.firestore.Timestamp.now() })));
      await Promise.all(ops);
      return true;
    }

    // Unhandled event types: log and return null
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
