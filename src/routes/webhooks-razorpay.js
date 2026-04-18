const express = require('express');
const verifySignature = require('../lib/razorpaySignature');
const razorpayService = require('../services/razorpayWebhook.service');

const router = express.Router();

/**
 * Razorpay webhook endpoint.
 * Important: use express.raw for this route only so that we can verify signature against raw body
 */
router.post('/', express.raw({ type: 'application/json' }), async (req, res) => {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  const signature = req.get('x-razorpay-signature');

  if (!signature) {
    console.warn('[webhooks.razorpay] missing signature header');
    return res.status(400).json({ error: 'Missing signature' });
  }

  const rawBody = req.body;
  if (!verifySignature(rawBody, signature, secret)) {
    console.warn('[webhooks.razorpay] invalid signature');
    return res.status(400).json({ error: 'Invalid signature' });
  }

  let event;
  try {
    const str = rawBody && rawBody.toString ? rawBody.toString('utf8') : '{}';
    event = JSON.parse(str);
  } catch (e) {
    console.error('[webhooks.razorpay] failed to parse JSON body', e);
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const eventId = event && event.id ? event.id : (event && event.event_id ? event.event_id : null);
  const userId = (event.payload && (event.payload.payment?.entity?.notes?.userId || event.payload.invoice?.entity?.notes?.userId || event.payload.subscription?.entity?.notes?.userId)) || null;
  console.log('[webhooks.razorpay] incoming event', event.event, eventId || '(no id)', 'userId=', userId);

  try {
    if (eventId && (await razorpayService.isEventProcessed(eventId))) {
      console.log('[webhooks.razorpay] event already processed, skipping', eventId);
      return res.status(200).json({ ok: true, skipped: true });
    }

    await razorpayService.handleEvent(event);

    if (eventId) await razorpayService.markEventProcessed(eventId, { type: event.event });

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[webhooks.razorpay] error processing event', err);
    // Do not mark processed so retries can occur
    return res.status(500).json({ error: 'Internal error' });
  }
});

module.exports = router;
