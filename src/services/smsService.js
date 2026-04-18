const fetch = require('node-fetch');

/**
 * Placeholder SMS service that integrates with a DLT SMS provider.
 * Environment variables expected:
 * - DLT_SMS_URL
 * - DLT_API_KEY
 * - DLT_SENDER_ID
 * - DLT_TEMPLATE_ID
 *
 * The exact payload depends on provider; update when provider details are available.
 */

async function sendOtpSms(phone, otp, opts = {}) {
  const url = process.env.DLT_SMS_URL;
  const apiKey = process.env.DLT_API_KEY;
  const sender = process.env.DLT_SENDER_ID;
  const templateId = opts.templateId || process.env.DLT_TEMPLATE_ID;

  // Require provider basics
  if (!url || !apiKey || !sender) {
    const err = new Error('DLT SMS provider not configured (DLT_SMS_URL/DLT_API_KEY/DLT_SENDER_ID required)');
    err.code = 'SMS_NOT_CONFIGURED';
    throw err;
  }

  // Determine payload: prefer templateId; otherwise use DLT_MESSAGE env var as message body
  let payload;
  if (templateId) {
    payload = { apiKey, sender, templateId, to: phone, params: { otp } };
  } else if (process.env.DLT_MESSAGE) {
    // Support provider message placeholder formats: {#var#} and {{otp}}
    let message = String(process.env.DLT_MESSAGE);
    message = message.replace(/\{#\s*var\s*#\}/gi, String(otp));
    message = message.replace(/{{\s*otp\s*}}/gi, String(otp));
    payload = { apiKey, sender, to: phone, message };
  } else {
    const err = new Error('DLT template or message not configured (DLT_TEMPLATE_ID or DLT_MESSAGE required)');
    err.code = 'SMS_TEMPLATE_NOT_CONFIGURED';
    throw err;
  }

  // Many Indian DLT providers accept query-string GET/POST style similar to your sample.
  // Build a query param URL matching: ?apikey=...&senderid=...&templateid=...&number=...&message=...
  const digits = String(payload.to).replace(/[^0-9]/g, '');
  const numberParam = digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : (digits.length === 10 ? digits : digits);

  const qs = new URLSearchParams();
  qs.set('apikey', payload.apiKey || apiKey);
  qs.set('senderid', payload.sender || sender);
  if (payload.templateId) qs.set('templateid', payload.templateId);
  qs.set('number', numberParam);
  if (payload.message) qs.set('message', payload.message);
  // If params exist (templated), include an example message param (some providers require it)
  if (payload.params && payload.params.otp) {
    let msg = process.env.DLT_MESSAGE ? String(process.env.DLT_MESSAGE) : `Your OTP is ${payload.params.otp}`;
    // replace both supported placeholders
    msg = msg.replace(/\{#\s*var\s*#\}/gi, String(payload.params.otp));
    msg = msg.replace(/{{\s*otp\s*}}/gi, String(payload.params.otp));
    if (!qs.has('message')) qs.set('message', msg);
  }

  const sendUrl = url.includes('?') ? `${url}&${qs.toString()}` : `${url}?${qs.toString()}`;

  // If dry run requested, return the constructed URL and payload without sending
  if (opts && opts.dryRun) {
    return { ok: true, dryRun: true, sendUrl, payload: Object.assign({}, payload) };
  }

  const resp = await fetch(sendUrl, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  });

  let data = {};
  try {
    data = await resp.json().catch(() => ({}));
  } catch (e) {
    // ignore JSON parse errors
  }
  if (!resp.ok) {
    const err = new Error('Failed to send SMS');
    err.code = 'SMS_SEND_FAILED';
    err.details = data;
    throw err;
  }

  return { ok: true, data };
}

module.exports = { sendOtpSms };
