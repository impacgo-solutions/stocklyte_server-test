'use strict';
const { Pool, types } = require('pg');

// node-postgres returns bigint (OID 20 — e.g. count(*)) and numeric/decimal (OID 1700 —
// e.g. stock.quantity) as strings by default, to avoid precision loss for values beyond
// what a JS number can represent exactly. Our columns never approach that range, and every
// Flutter model on the other end expects a plain JSON number (matching the old
// supabase-js/PostgREST behavior) — so parse both as numbers globally, once, here.
types.setTypeParser(20, (val) => parseInt(val, 10));
types.setTypeParser(1700, (val) => parseFloat(val));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX) || 10,
  // Supabase's pooler presents a cert most Node deployments don't have in their trust
  // store; rejectUnauthorized:false still encrypts the connection, it just skips chain
  // validation (standard for managed Postgres providers). Opt out with PGSSL=disable
  // for environments (e.g. plain local Postgres) that don't need/support TLS at all.
  ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
});

// A client sitting idle in the pool can still emit an 'error' (e.g. the server closed the
// connection). pg's own docs warn this crashes the process if nothing is listening.
pool.on('error', (err) => {
  console.error('[pg pool] unexpected error on idle client', err.message);
});

// Tenant schema names only ever come from our own slugifier (tenantProvisioning.js) or
// values already stored in public.companies / a verified JWT — never raw client input —
// but every call site re-validates against this before it's ever used, since Postgres
// identifiers can't be bound as query parameters the way values can.
const SCHEMA_NAME_RE = /^[a-z][a-z0-9_]{2,63}$/;

function assertValidSchemaName(schemaName) {
  if (typeof schemaName !== 'string' || !SCHEMA_NAME_RE.test(schemaName)) {
    throw new Error(`Invalid tenant schema name: ${schemaName}`);
  }
}

// Runs `fn(client)` inside a transaction with search_path pinned to the given tenant
// schema (falling back to public after it) and, when userId is provided, exposes it to
// triggers via the `app.current_user_id` session GUC (there is no PostgREST-style
// auth.uid() available on this raw connection). Both are set through set_config() so the
// schema name and user id are bound as query parameters, never interpolated into SQL text.
async function withTenant(schemaName, userIdOrFn, maybeFn) {
  assertValidSchemaName(schemaName);
  const userId = typeof maybeFn === 'function' ? userIdOrFn : null;
  const fn = typeof maybeFn === 'function' ? maybeFn : userIdOrFn;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`select set_config('search_path', $1, true)`, [`${schemaName}, public`]);
    if (userId) {
      await client.query(`select set_config('app.current_user_id', $1, true)`, [userId]);
    }
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, withTenant, assertValidSchemaName, SCHEMA_NAME_RE };
