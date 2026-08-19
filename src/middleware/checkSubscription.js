'use strict';
const { pool } = require('../utils/db');
const { getCompanySubscription, isExpired, TRIAL_EXPIRED_MESSAGE } = require('../utils/subscription');
const { fail } = require('../utils/response');

// Blocks Company Admins and staff alike once their tenant's 15-day trial has lapsed
// (or a subscription was cancelled) and nobody has flipped subscription_status back to
// 'active'. Checked against the DB on every request rather than baked into the JWT, so
// an expiry takes effect immediately instead of waiting out the access token's 12h
// lifetime. Mount this after `authenticate` on tenant-facing routes only — super_admin
// requests have no tenant_schema and skip straight through.
module.exports = async function checkSubscription(req, res, next) {
  if (!req.user?.tenant_schema) return next();

  try {
    const company = await getCompanySubscription(req.user.tenant_schema);
    if (!company) return fail(res, 'Account not found', 404);

    if (isExpired(company)) {
      if (company.subscription_status === 'trialing') {
        // Lazily persist the transition so it's recorded, not just recomputed each request.
        pool.query(
          `update public.companies set subscription_status = 'expired' where schema_name = $1 and subscription_status = 'trialing'`,
          [req.user.tenant_schema]
        ).catch(() => {});
      }
      return fail(res, TRIAL_EXPIRED_MESSAGE, 402);
    }

    next();
  } catch (err) {
    next(err);
  }
};
