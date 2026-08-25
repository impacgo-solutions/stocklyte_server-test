'use strict';

const ok = (res, data, statusCode = 200) =>
  res.status(statusCode).json({ success: true, data });

const fail = (res, message, statusCode = 400) =>
  res.status(statusCode).json({ success: false, error: message });

const paginate = (res, data, total, page, limit) =>
  res.status(200).json({
    success: true,
    data,
    meta: { total, page: Number(page), limit: Number(limit), pages: Math.ceil(total / limit) }
  });

// admin_users/super_admins rows are frequently spread verbatim (`select *`,
// `returning *`) straight into a response — this strips the bcrypt hash
// before it goes out. `undefined` (not delete/null) so JSON.stringify omits
// the key entirely rather than sending `"password_hash": null`.
const stripSensitive = (row) => (row ? { ...row, password_hash: undefined } : row);
const stripSensitiveList = (rows) => (Array.isArray(rows) ? rows.map(stripSensitive) : rows);

module.exports = { ok, fail, paginate, stripSensitive, stripSensitiveList };
