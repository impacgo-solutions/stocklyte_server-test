'use strict';

// Read-side counterpart to stock.js's assertLocationAccess(): an admin (and
// a tenant-wide viewer/auditor with no assigned warehouse) sees data across
// every warehouse; a manager or staff member — the roles that already only
// ever *act* on their own assigned warehouse (see assertLocationAccess,
// transfers.js's assertSourceParty, etc.) — is confined to that same single
// warehouse (admin_users.location_id, carried on the JWT) for every report
// and list endpoint too.
//
// Returns null when the caller is unrestricted (tenant-wide). Returns the
// location_id to scope to otherwise. Throws a 403 if a manager/staff account
// has no warehouse assigned, rather than silently granting or denying all
// access.
function scopeLocationId(req) {
  const role = req.user.role;
  if (role === 'admin' || role === 'viewer') return null;
  if (!req.user.location_id) {
    throw Object.assign(new Error('Your account has no assigned warehouse'), { status: 403 });
  }
  return req.user.location_id;
}

module.exports = { scopeLocationId };
