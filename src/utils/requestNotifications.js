'use strict';

// Writes a `notifications` row (type='product_request') for every admin_user who
// should hear about a product-request lifecycle event: everyone based at
// `locationId` (if given) plus every tenant admin (role='admin') for oversight,
// deduplicated. Called from inside the same withTenant transaction as the
// request mutation so a failure here rolls back the whole action.
async function notifyRequestEvent(client, { locationId, title, body, requestId, relatedProductId }) {
  const { rows: recipients } = await client.query(
    `select id from admin_users
     where is_active = true and (role = 'admin' or ($1::uuid is not null and location_id = $1))`,
    [locationId || null]
  );
  if (recipients.length === 0) return;

  const values = [];
  const params = [];
  recipients.forEach((r) => {
    params.push(r.id, title, body, 'product_request', requestId || null, relatedProductId || null);
    const base = params.length - 6;
    values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`);
  });

  await client.query(
    `insert into notifications (user_id, title, body, type, related_request_id, related_product_id)
     values ${values.join(', ')}`,
    params
  );
}

module.exports = { notifyRequestEvent };
