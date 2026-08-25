'use strict';

// Writes a `notifications` row (type='transfer') for every admin_user who
// should hear about a transfer lifecycle event: the specific `userId` (if
// given — used when a transfer is routed to one named approver), everyone
// based at `locationId` (if given), plus every tenant admin (role='admin')
// for oversight, deduplicated. Mirrors utils/requestNotifications.js's
// notifyRequestEvent, minus a related-record FK — the notifications table
// only has related_request_id (product_requests), not a transfer
// equivalent, so the transfer number is carried in the body text instead.
async function notifyTransferEvent(client, { locationId, userId, title, body }) {
  const { rows: recipients } = await client.query(
    `select id from admin_users
     where is_active = true and (
       role = 'admin'
       or ($1::uuid is not null and location_id = $1)
       or ($2::uuid is not null and id = $2)
     )`,
    [locationId || null, userId || null]
  );
  if (recipients.length === 0) return;

  const values = [];
  const params = [];
  recipients.forEach((r) => {
    params.push(r.id, title, body, 'transfer');
    const base = params.length - 4;
    values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`);
  });

  await client.query(
    `insert into notifications (user_id, title, body, type) values ${values.join(', ')}`,
    params
  );
}

module.exports = { notifyTransferEvent };
