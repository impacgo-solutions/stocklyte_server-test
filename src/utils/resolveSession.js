'use strict';
const { pool, withTenant } = require('./db');
const { getCompanySubscription } = require('./subscription');

// Given a Supabase Auth user id (already password-verified by supabase.auth
// .signInWithPassword), figures out whether this is the platform super_admin or a
// tenant user, and returns the profile + JWT payload fields for either case. Used by
// both /auth/login and /auth/refresh so refreshed tokens always reflect current
// role/active-status, not whatever was true when the old token was issued.
async function resolveSession(userId) {
  const { rows: superAdminRows } = await pool.query(
    'select * from public.super_admins where id = $1 and is_active',
    [userId]
  );
  if (superAdminRows.length > 0) {
    const superAdmin = superAdminRows[0];
    return {
      tokenPayload: { sub: userId, role: 'super_admin' },
      profile: { ...superAdmin, role: 'super_admin' },
    };
  }

  const { rows: indexRows } = await pool.query(
    'select schema_name from public.tenant_user_index where user_id = $1',
    [userId]
  );
  if (indexRows.length === 0) {
    throw new Error('This account is not provisioned for Vaultiq.');
  }
  const schemaName = indexRows[0].schema_name;

  const profile = await withTenant(schemaName, async (client) => {
    const { rows } = await client.query('select * from admin_users where id = $1 and is_active', [userId]);
    return rows[0] || null;
  });
  if (!profile) {
    throw new Error('Your account is inactive. Contact your administrator.');
  }

  // Surfaced on `profile` (not just enforced server-side by checkSubscription) so the
  // client can show a trial countdown / "trial expired" screen right after login,
  // before it ever has to hit a blocked endpoint.
  const subscription = await getCompanySubscription(schemaName);

  return {
    tokenPayload: {
      sub: userId,
      role: profile.role,
      tenant_schema: schemaName,
      location_id: profile.location_id || undefined,
    },
    profile: {
      ...profile,
      subscription_status: subscription?.subscription_status || null,
      trial_ends_at: subscription?.trial_ends_at || null,
    },
  };
}

module.exports = { resolveSession };
