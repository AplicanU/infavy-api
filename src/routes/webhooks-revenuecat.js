const express = require('express');
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
  // Intentionally skip signature verification for RevenueCat webhooks.
  // The raw body is still required so we parse it manually to verify JSON.
  const rawBody = req.body;

  let event;
  try {
    const str = rawBody && rawBody.toString ? rawBody.toString('utf8') : '{}';
    event = JSON.parse(str);
  } catch (e) {
    console.error('[webhooks.revenuecat] failed to parse JSON body', e);
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  // RevenueCat event id field may vary; try common keys
  const eventId = event?.event_id || event?.id || event?.data?.id || event?.data?.subscriber?.original_transaction_id || null;
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
