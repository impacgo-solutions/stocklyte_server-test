-- ============================================================================
-- Bug fix: deleting a location referenced by product_requests/routes crashed
-- ============================================================================
-- product_requests.source_location_id and product_request_routes.target_
-- location_id are both NOT NULL (a request/hop must always know its
-- location) but their FKs were defined ON DELETE SET NULL — self-
-- contradictory: deleting a referenced location made Postgres try to null
-- out a NOT NULL column, raising a raw "null value ... violates not-null
-- constraint" error (23502) instead of the intended, friendly "Cannot
-- delete location because it still has stock/requests" 409 that
-- routes/locations.js already handles for the 23503 foreign_key_violation
-- code stock deletion produces. Found via QA testing (LOC-5).
--
-- Fix: ON DELETE RESTRICT instead — consistent with the NOT NULL constraint,
-- and produces the standard 23503 the existing error handler already
-- catches gracefully. No column, table, or app-visible shape changes.
-- Idempotent; safe to re-run.
-- ============================================================================

alter table template.product_requests
  drop constraint if exists product_requests_source_location_id_fkey;
alter table template.product_requests
  add constraint product_requests_source_location_id_fkey
  foreign key (source_location_id) references template.locations (id) on delete restrict;

alter table template.product_request_routes
  drop constraint if exists product_request_routes_target_location_id_fkey;
alter table template.product_request_routes
  add constraint product_request_routes_target_location_id_fkey
  foreign key (target_location_id) references template.locations (id) on delete restrict;

do $$
declare
  r record;
begin
  for r in select schema_name from public.companies loop
    execute format('alter table %1$I.product_requests drop constraint if exists product_requests_source_location_id_fkey', r.schema_name);
    execute format('alter table %1$I.product_requests add constraint product_requests_source_location_id_fkey foreign key (source_location_id) references %1$I.locations (id) on delete restrict', r.schema_name);

    execute format('alter table %1$I.product_request_routes drop constraint if exists product_request_routes_target_location_id_fkey', r.schema_name);
    execute format('alter table %1$I.product_request_routes add constraint product_request_routes_target_location_id_fkey foreign key (target_location_id) references %1$I.locations (id) on delete restrict', r.schema_name);
  end loop;
end;
$$;
