const express = require('express');
const verifySignature = require('../lib/revenuecatSignature');
const revenuecatService = require('../services/revenuecatWebhook.service');

const router = express.Router();

/**
 * @openapi
 * /api/v1/webhooks/revenuecat:
 *   post:
 *     summary: RevenueCat webhook endpoint (raw body expected)
 */
/**
 * RevenueCat webhook endpoint.
 * Important: use express.raw for this route only so that we can verify signature against raw body
 */
router.post('/', express.raw({ type: 'application/json' }), async (req, res) => {
  const secret = process.env.REVENUECAT_WEBHOOK_SECRET;
  const signature = req.get('x-revenuecat-signature') || req.get('revenuecat-signature');

  if (!signature) {
    console.warn('[webhooks.revenuecat] missing signature header');
    // If no secret is configured, we still allow processing but warn.
    if (!secret) {
      console.warn('[webhooks.revenuecat] no webhook secret configured, proceeding without verification');
    } else {
      return res.status(400).json({ error: 'Missing signature' });
    }
  }

  const rawBody = req.body;
  if (secret && signature && !verifySignature(rawBody, signature, secret)) {
    console.warn('[webhooks.revenuecat] invalid signature');
    return res.status(400).json({ error: 'Invalid signature' });
  }

  let event;
  try {
    const str = rawBody && rawBody.toString ? rawBody.toString('utf8') : '{}';
    event = JSON.parse(str);
  } catch (e) {
    console.error('[webhooks.revenuecat] failed to parse JSON body', e);
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  // RevenueCat event id field may vary; try a few common keys
  const eventId = event && (event.event_id || event.id || event.data?.id) ? (event.event_id || event.id || event.data?.id) : null;
  const userId = event?.app_user_id || event?.data?.app_user_id || event?.data?.subscriber?.app_user_id || null;
  console.log('[webhooks.revenuecat] incoming event', event?.type || event?.event || '(unknown)', eventId || '(no id)', 'userId=', userId);

  try {
    if (eventId && (await revenuecatService.isEventProcessed(eventId))) {
      console.log('[webhooks.revenuecat] event already processed, skipping', eventId);
      return res.status(200).json({ ok: true, skipped: true });
    }

    await revenuecatService.handleEvent(event);

    if (eventId) await revenuecatService.markEventProcessed(eventId, { type: event?.type || null });

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[webhooks.revenuecat] error processing event', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

module.exports = router;
