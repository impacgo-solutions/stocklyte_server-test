'use strict';
const router = require('express').Router();
const { withTenant } = require('../utils/db');
const authenticate = require('../middleware/auth');
const checkSubscription = require('../middleware/checkSubscription');
const { ok, fail } = require('../utils/response');

router.use(authenticate, checkSubscription);

// GET /notifications
router.get('/', async (req, res) => {
  try {
    const notifications = await withTenant(req.user.tenant_schema, async (client) => {
      const { rows } = await client.query(
        `select n.*,
                case when p.id is null then null
                  else jsonb_build_object('id', p.id, 'name', p.name, 'sku', p.sku, 'image_url', p.image_url)
                end as products
         from notifications n
         left join products p on p.id = n.related_product_id
         where n.user_id = $1
         order by n.created_at desc
         limit 50`,
        [req.user.id]
      );
      return rows;
    });
    return ok(res, notifications);
  } catch (err) {
    return fail(res, err.message);
  }
});

// PUT /notifications/read-all  — must be defined BEFORE /:id/read to prevent
// Express matching the literal string "read-all" as an id parameter.
router.put('/read-all', async (req, res) => {
  try {
    await withTenant(req.user.tenant_schema, async (client) => {
      await client.query('update notifications set is_read = true where user_id = $1 and is_read = false', [req.user.id]);
    });
    return ok(res, { marked: true });
  } catch (err) {
    return fail(res, err.message);
  }
});

// PUT /notifications/:id/read
router.put('/:id/read', async (req, res) => {
  try {
    await withTenant(req.user.tenant_schema, async (client) => {
      await client.query('update notifications set is_read = true where id = $1 and user_id = $2', [req.params.id, req.user.id]);
    });
    return ok(res, { marked: true });
  } catch (err) {
    return fail(res, err.message);
  }
});

module.exports = router;
