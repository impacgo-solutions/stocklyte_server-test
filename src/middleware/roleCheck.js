'use strict';
const { fail } = require('../utils/response');

const ROLE_HIERARCHY = { super_admin: 5, admin: 4, manager: 3, staff: 2, viewer: 1 };

function requireRole(...allowedRoles) {
  return (req, res, next) => {
    const userRole = req.user?.role;
    if (!userRole || !allowedRoles.includes(userRole)) {
      return fail(res, 'Insufficient permissions', 403);
    }
    next();
  };
}

function requireMinRole(minRole) {
  return (req, res, next) => {
    const userLevel = ROLE_HIERARCHY[req.user?.role] || 0;
    const minLevel = ROLE_HIERARCHY[minRole] || 0;
    if (userLevel < minLevel) {
      return fail(res, 'Insufficient permissions', 403);
    }
    next();
  };
}

module.exports = { requireRole, requireMinRole };
