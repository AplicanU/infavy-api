/**
 * Helper utilities for subscription access checks
 */
function canUserAccessContent(subscription) {
  if (!subscription) return false;

  const now = new Date();
  const status = subscription.status;
  const endDateTs = subscription.endDate;
  const endDate = endDateTs && endDateTs.toDate ? endDateTs.toDate() : (endDateTs instanceof Date ? endDateTs : null);

  if (status === 'active' && endDate && endDate > now) return true;

  // Grace period for past_due
  if (status === 'past_due' && endDate && endDate > now) return true;

  // If endDate < now and status in halted/cancelled/expired -> deny
  if (endDate && endDate < now && (status === 'halted' || status === 'cancelled' || status === 'expired')) return false;

  return false;
}

module.exports = {
  canUserAccessContent,
};
