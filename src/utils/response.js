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

module.exports = { ok, fail, paginate };
