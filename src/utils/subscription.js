'use strict';
const { pool } = require('./db');

const TRIAL_EXPIRED_MESSAGE = 'Your 15-day free trial has ended. Contact info@impacgo.com to resume services.';

async function getCompanySubscription(schemaName) {
  const { rows } = await pool.query(
    'select subscription_status, trial_ends_at from public.companies where schema_name = $1',
    [schemaName]
  );
  return rows[0] || null;
}

// `company` is a row (or projection) from public.companies with `subscription_status`
// and `trial_ends_at`. Trial expiry is computed from trial_ends_at rather than only
// trusting subscription_status, so a lapsed trial is caught even before anything has
// lazily flipped the status column to 'expired'.
function isExpired(company) {
  if (!company) return false;
  if (company.subscription_status === 'expired' || company.subscription_status === 'cancelled') return true;
  return company.subscription_status === 'trialing' && new Date(company.trial_ends_at) < new Date();
}

module.exports = { getCompanySubscription, isExpired, TRIAL_EXPIRED_MESSAGE };
