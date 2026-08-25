'use strict';
const { pool, assertValidSchemaName } = require('./db');

// Dependency order matters: a table can only reference tables created before it.
const TABLES = [
  'locations',
  'admin_users',
  'categories',
  'products',
  'stock',
  'stock_transactions',
  'audit_log',
  'notifications',
  'clusters',
  'racks',
  'rack_stock',
  'bins',
  'bin_stock',
  'location_routing_rules',
  'product_requests',
  'product_request_routes',
  'product_request_status_history',
  'transfers',
  'transfer_items',
  'transfer_status_history',
  'cluster_relationships',
];

// Foreign keys are never copied by `LIKE ... INCLUDING ALL` — Postgres only carries over
// defaults/checks/indexes/storage, never FK constraints — so every one is re-added here,
// pointed at the new schema's own tables (except the one FK to the global auth.users).
function foreignKeyStatements(schemaName) {
  const q = (name) => `"${schemaName}".${name}`;
  return [
    `alter table ${q('admin_users')} add constraint admin_users_location_id_fkey foreign key (location_id) references ${q('locations')}(id) on delete set null`,
    `alter table ${q('products')} add constraint products_category_id_fkey foreign key (category_id) references ${q('categories')}(id) on delete set null`,
    `alter table ${q('stock')} add constraint stock_product_id_fkey foreign key (product_id) references ${q('products')}(id) on delete cascade`,
    `alter table ${q('stock')} add constraint stock_location_id_fkey foreign key (location_id) references ${q('locations')}(id) on delete cascade`,
    `alter table ${q('stock_transactions')} add constraint stock_transactions_product_id_fkey foreign key (product_id) references ${q('products')}(id) on delete cascade`,
    `alter table ${q('stock_transactions')} add constraint stock_transactions_from_location_id_fkey foreign key (from_location_id) references ${q('locations')}(id) on delete set null`,
    `alter table ${q('stock_transactions')} add constraint stock_transactions_to_location_id_fkey foreign key (to_location_id) references ${q('locations')}(id) on delete set null`,
    `alter table ${q('stock_transactions')} add constraint stock_transactions_performed_by_fkey foreign key (performed_by) references ${q('admin_users')}(id) on delete set null`,
    `alter table ${q('audit_log')} add constraint audit_log_performed_by_fkey foreign key (performed_by) references ${q('admin_users')}(id) on delete set null`,
    `alter table ${q('notifications')} add constraint notifications_user_id_fkey foreign key (user_id) references ${q('admin_users')}(id) on delete cascade`,
    `alter table ${q('notifications')} add constraint notifications_related_product_id_fkey foreign key (related_product_id) references ${q('products')}(id) on delete set null`,
    // Cluster-based product request & rejection workflow
    `alter table ${q('locations')} add constraint locations_cluster_id_fkey foreign key (cluster_id) references ${q('clusters')}(id) on delete set null`,
    `alter table ${q('racks')} add constraint racks_location_id_fkey foreign key (location_id) references ${q('locations')}(id) on delete cascade`,
    `alter table ${q('rack_stock')} add constraint rack_stock_product_id_fkey foreign key (product_id) references ${q('products')}(id) on delete cascade`,
    `alter table ${q('rack_stock')} add constraint rack_stock_rack_id_fkey foreign key (rack_id) references ${q('racks')}(id) on delete cascade`,
    `alter table ${q('bins')} add constraint bins_rack_id_fkey foreign key (rack_id) references ${q('racks')}(id) on delete cascade`,
    `alter table ${q('bin_stock')} add constraint bin_stock_product_id_fkey foreign key (product_id) references ${q('products')}(id) on delete cascade`,
    `alter table ${q('bin_stock')} add constraint bin_stock_bin_id_fkey foreign key (bin_id) references ${q('bins')}(id) on delete cascade`,
    `alter table ${q('location_routing_rules')} add constraint location_routing_rules_source_location_id_fkey foreign key (source_location_id) references ${q('locations')}(id) on delete cascade`,
    `alter table ${q('location_routing_rules')} add constraint location_routing_rules_target_location_id_fkey foreign key (target_location_id) references ${q('locations')}(id) on delete cascade`,
    `alter table ${q('product_requests')} add constraint product_requests_product_id_fkey foreign key (product_id) references ${q('products')}(id) on delete cascade`,
    `alter table ${q('product_requests')} add constraint product_requests_requested_by_fkey foreign key (requested_by) references ${q('admin_users')}(id) on delete set null`,
    `alter table ${q('product_requests')} add constraint product_requests_source_location_id_fkey foreign key (source_location_id) references ${q('locations')}(id) on delete restrict`,
    `alter table ${q('product_requests')} add constraint product_requests_current_target_location_id_fkey foreign key (current_target_location_id) references ${q('locations')}(id) on delete set null`,
    `alter table ${q('product_requests')} add constraint product_requests_cancelled_by_fkey foreign key (cancelled_by) references ${q('admin_users')}(id) on delete set null`,
    `alter table ${q('product_request_routes')} add constraint product_request_routes_request_id_fkey foreign key (request_id) references ${q('product_requests')}(id) on delete cascade`,
    `alter table ${q('product_request_routes')} add constraint product_request_routes_target_location_id_fkey foreign key (target_location_id) references ${q('locations')}(id) on delete restrict`,
    `alter table ${q('product_request_routes')} add constraint product_request_routes_decided_by_fkey foreign key (decided_by) references ${q('admin_users')}(id) on delete set null`,
    `alter table ${q('product_request_status_history')} add constraint product_request_status_history_request_id_fkey foreign key (request_id) references ${q('product_requests')}(id) on delete cascade`,
    `alter table ${q('product_request_status_history')} add constraint product_request_status_history_location_id_fkey foreign key (location_id) references ${q('locations')}(id) on delete set null`,
    `alter table ${q('product_request_status_history')} add constraint product_request_status_history_performed_by_fkey foreign key (performed_by) references ${q('admin_users')}(id) on delete set null`,
    `alter table ${q('stock_transactions')} add constraint stock_transactions_related_request_id_fkey foreign key (related_request_id) references ${q('product_requests')}(id) on delete set null`,
    `alter table ${q('notifications')} add constraint notifications_related_request_id_fkey foreign key (related_request_id) references ${q('product_requests')}(id) on delete set null`,
    // Transfer Management & Transfer Reports workflow
    `alter table ${q('transfers')} add constraint transfers_source_location_id_fkey foreign key (source_location_id) references ${q('locations')}(id) on delete restrict`,
    `alter table ${q('transfers')} add constraint transfers_destination_location_id_fkey foreign key (destination_location_id) references ${q('locations')}(id) on delete restrict`,
    `alter table ${q('transfers')} add constraint transfers_requested_by_fkey foreign key (requested_by) references ${q('admin_users')}(id) on delete set null`,
    `alter table ${q('transfers')} add constraint transfers_approved_by_fkey foreign key (approved_by) references ${q('admin_users')}(id) on delete set null`,
    `alter table ${q('transfers')} add constraint transfers_shipped_by_fkey foreign key (shipped_by) references ${q('admin_users')}(id) on delete set null`,
    `alter table ${q('transfers')} add constraint transfers_received_by_fkey foreign key (received_by) references ${q('admin_users')}(id) on delete set null`,
    `alter table ${q('transfers')} add constraint transfers_rejected_by_fkey foreign key (rejected_by) references ${q('admin_users')}(id) on delete set null`,
    `alter table ${q('transfers')} add constraint transfers_cancelled_by_fkey foreign key (cancelled_by) references ${q('admin_users')}(id) on delete set null`,
    `alter table ${q('transfer_items')} add constraint transfer_items_transfer_id_fkey foreign key (transfer_id) references ${q('transfers')}(id) on delete cascade`,
    `alter table ${q('transfer_items')} add constraint transfer_items_product_id_fkey foreign key (product_id) references ${q('products')}(id) on delete cascade`,
    `alter table ${q('transfer_status_history')} add constraint transfer_status_history_transfer_id_fkey foreign key (transfer_id) references ${q('transfers')}(id) on delete cascade`,
    `alter table ${q('transfer_status_history')} add constraint transfer_status_history_performed_by_fkey foreign key (performed_by) references ${q('admin_users')}(id) on delete set null`,
    `alter table ${q('stock_transactions')} add constraint stock_transactions_related_transfer_id_fkey foreign key (related_transfer_id) references ${q('transfers')}(id) on delete set null`,
    // Hierarchy-based approval routing — inert until 008_transfer_approval_hierarchy_template.sql
    // has actually been applied to `template` (these columns don't exist until then).
    `alter table ${q('admin_users')} add constraint admin_users_reports_to_fkey foreign key (reports_to) references ${q('admin_users')}(id) on delete set null`,
    `alter table ${q('transfers')} add constraint transfers_pending_approver_id_fkey foreign key (pending_approver_id) references ${q('admin_users')}(id) on delete set null`,
    // Cluster Relationship Management
    `alter table ${q('cluster_relationships')} add constraint cluster_relationships_source_cluster_id_fkey foreign key (source_cluster_id) references ${q('clusters')}(id) on delete cascade`,
    `alter table ${q('cluster_relationships')} add constraint cluster_relationships_target_cluster_id_fkey foreign key (target_cluster_id) references ${q('clusters')}(id) on delete cascade`,
  ];
}

const FUNCTION_NAMES = [
  'update_updated_at',
  'audit_trigger_func',
  'notify_low_stock',
  'stock_in_lot',
  'stock_out',
  'transfer_stock',
  'generate_routing_sequence',
  'next_eligible_location',
  'create_product_request',
  'reject_product_request',
  'accept_product_request',
  'receive_product_request',
  'cancel_product_request',
  'report_damaged_stock',
  'restore_damaged_stock',
  'writeoff_damaged_stock',
  'submit_transfer',
  'approve_transfer',
  'reject_transfer',
  'ship_transfer',
  'receive_transfer',
  'cancel_transfer',
];

// Trigger structure is stable and small enough to hand-maintain here rather than
// reverse-engineer from pg_trigger — keep in sync with supabase/template_schema.sql.
function triggerStatements(schemaName) {
  const q = (name) => `"${schemaName}".${name}`;
  return [
    `create trigger products_updated_at before update on ${q('products')} for each row execute function ${q('update_updated_at')}()`,
    `create trigger stock_updated_at before update on ${q('stock')} for each row execute function ${q('update_updated_at')}()`,
    `create trigger audit_products after insert or update or delete on ${q('products')} for each row execute function ${q('audit_trigger_func')}()`,
    `create trigger audit_stock after insert or update or delete on ${q('stock')} for each row execute function ${q('audit_trigger_func')}()`,
    `create trigger audit_locations after insert or update or delete on ${q('locations')} for each row execute function ${q('audit_trigger_func')}()`,
    `create trigger stock_low_stock_check after insert or update of quantity on ${q('stock')} for each row execute function ${q('notify_low_stock')}()`,
    `create trigger product_requests_updated_at before update on ${q('product_requests')} for each row execute function ${q('update_updated_at')}()`,
    `create trigger audit_product_requests after insert or update or delete on ${q('product_requests')} for each row execute function ${q('audit_trigger_func')}()`,
    `create trigger location_routing_rules_updated_at before update on ${q('location_routing_rules')} for each row execute function ${q('update_updated_at')}()`,
    `create trigger rack_stock_updated_at before update on ${q('rack_stock')} for each row execute function ${q('update_updated_at')}()`,
    `create trigger bin_stock_updated_at before update on ${q('bin_stock')} for each row execute function ${q('update_updated_at')}()`,
    `create trigger transfers_updated_at before update on ${q('transfers')} for each row execute function ${q('update_updated_at')}()`,
    `create trigger audit_transfers after insert or update or delete on ${q('transfers')} for each row execute function ${q('audit_trigger_func')}()`,
  ];
}

// Company name -> a valid, unique Postgres schema identifier.
function slugify(companyName) {
  let slug = companyName
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 50);
  if (!slug || !/^[a-z]/.test(slug)) slug = `co_${slug}`;
  return slug;
}

async function generateUniqueSchemaName(client, companyName) {
  const base = slugify(companyName);
  let candidate = base;
  let suffix = 2;
  // Small table, small N — a loop of individual lookups is simplest and clear.
  while (true) {
    const { rows } = await client.query('select 1 from public.companies where schema_name = $1', [candidate]);
    if (rows.length === 0) return candidate;
    candidate = `${base}_${suffix}`;
    suffix += 1;
  }
}

// Clones supabase/template_schema.sql's `template` schema into a brand new schema named
// `schemaName`, inside a single transaction — any failure rolls back the whole thing so a
// half-created tenant schema never lingers.
async function createTenantSchema(schemaName) {
  assertValidSchemaName(schemaName);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`create schema "${schemaName}"`);

    for (const table of TABLES) {
      await client.query(`create table "${schemaName}"."${table}" (like template."${table}" including all)`);
    }

    for (const stmt of foreignKeyStatements(schemaName)) {
      await client.query(stmt);
    }

    // Functions are cloned from their live template definition (the single source of
    // truth an operator maintains in the `template` schema) rather than hand-duplicated,
    // so behavior changes to the template only need to be made in one place.
    const { rows: fnRows } = await client.query(
      `select p.proname, pg_get_functiondef(p.oid) as def
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'template' and p.proname = any($1)`,
      [FUNCTION_NAMES]
    );
    if (fnRows.length !== FUNCTION_NAMES.length) {
      const found = new Set(fnRows.map((r) => r.proname));
      const missing = FUNCTION_NAMES.filter((n) => !found.has(n));
      throw new Error(`template schema is missing function(s): ${missing.join(', ')}`);
    }
    for (const { def } of fnRows) {
      // The only place the literal word "template" appears in these function
      // definitions is the schema-qualifier on the function name and the
      // `SET search_path TO 'template', 'public'` clause — swapping both at once
      // is what re-homes the cloned function to the new schema.
      const rewritten = def.replace(/template/g, schemaName);
      await client.query(rewritten);
    }

    for (const stmt of triggerStatements(schemaName)) {
      await client.query(stmt);
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { slugify, generateUniqueSchemaName, createTenantSchema };
