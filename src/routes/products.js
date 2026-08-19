'use strict';
const router = require('express').Router();
const multer = require('multer');
const { supabase } = require('../utils/supabase');
const { withTenant } = require('../utils/db');
const authenticate = require('../middleware/auth');
const checkSubscription = require('../middleware/checkSubscription');
const { requireRole, requireMinRole } = require('../middleware/roleCheck');
const { ok, fail, paginate } = require('../utils/response');

const ALLOWED_MIME = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME.has(file.mimetype)) {
      return cb(new Error('Only JPEG, PNG, and WebP images are allowed'));
    }
    cb(null, true);
  },
});

router.use(authenticate, checkSubscription);

// Attaches `categories` (single object or null) and `stock` (array, joined with
// location name) to a batch of product rows the same shape the Flutter models expect.
async function attachRelations(client, products) {
  const productIds = products.map((p) => p.id);
  let categoryById = {};
  let stockByProduct = {};

  const categoryIds = [...new Set(products.map((p) => p.category_id).filter(Boolean))];
  if (categoryIds.length > 0) {
    const { rows } = await client.query('select * from categories where id = any($1)', [categoryIds]);
    categoryById = Object.fromEntries(rows.map((c) => [c.id, c]));
  }

  if (productIds.length > 0) {
    const { rows } = await client.query(
      `select s.*, l.name as location_name
       from stock s join locations l on l.id = s.location_id
       where s.product_id = any($1)`,
      [productIds]
    );
    for (const s of rows) {
      (stockByProduct[s.product_id] ||= []).push({
        id: s.id,
        product_id: s.product_id,
        location_id: s.location_id,
        quantity: s.quantity,
        updated_at: s.updated_at,
        locations: { name: s.location_name },
      });
    }
  }

  return products.map((p) => ({
    ...p,
    categories: p.category_id ? categoryById[p.category_id] || null : null,
    stock: stockByProduct[p.id] || [],
  }));
}

// GET /products — search, filter, paginate
router.get('/', async (req, res) => {
  const { search, category_id, location_id, low_stock, page = 1, limit = 20, active = 'true' } = req.query;
  const offset = (Number(page) - 1) * Number(limit);
  // location_id and low_stock filters must be evaluated after joining stock data, so we
  // fetch all matching products (no LIMIT) and paginate the filtered set in JS instead.
  const needsStockFilter = Boolean(location_id) || low_stock === 'true';

  try {
    const { rows, totalCount } = await withTenant(req.user.tenant_schema, async (client) => {
      const conditions = [];
      const params = [];
      if (active === 'true') {
        conditions.push('is_active = true');
      }
      if (search) {
        const safe = search.replace(/[%_]/g, '\\$&');
        params.push(`%${safe}%`);
        conditions.push(`(name ILIKE $${params.length} OR sku ILIKE $${params.length} OR barcode ILIKE $${params.length})`);
      }
      if (category_id) {
        params.push(category_id);
        conditions.push(`category_id = $${params.length}`);
      }
      const where = conditions.length ? `where ${conditions.join(' and ')}` : '';

      const { rows: countRows } = await client.query(`select count(*)::int as count from products ${where}`, params);
      const totalCount = countRows[0].count;

      let query = `select * from products ${where} order by created_at desc`;
      if (!needsStockFilter) {
        params.push(Number(limit));
        query += ` limit $${params.length}`;
        params.push(offset);
        query += ` offset $${params.length}`;
      }
      const { rows } = await client.query(query, params);
      return { rows, totalCount };
    });

    const enriched = await withTenant(req.user.tenant_schema, (client) => attachRelations(client, rows));

    let filtered = enriched;
    if (location_id) {
      filtered = filtered.filter((p) => p.stock.some((s) => s.location_id === location_id));
    }
    if (low_stock === 'true') {
      filtered = filtered.filter((p) => {
        const total = p.stock.reduce((sum, s) => sum + parseFloat(s.quantity || 0), 0);
        return total <= (p.low_stock_threshold || 10);
      });
    }

    if (needsStockFilter) {
      const filteredCount = filtered.length;
      const pageNum = Number(page);
      const limitNum = Number(limit);
      const start = (pageNum - 1) * limitNum;
      filtered = filtered.slice(start, start + limitNum);
      return paginate(res, filtered, filteredCount, page, limit);
    }

    return paginate(res, filtered, totalCount, page, limit);
  } catch (err) {
    return fail(res, err.message);
  }
});

// GET /products/barcode/:barcode
router.get('/barcode/:barcode', async (req, res) => {
  try {
    const product = await withTenant(req.user.tenant_schema, async (client) => {
      const { rows } = await client.query('select * from products where barcode = $1', [req.params.barcode]);
      if (!rows[0]) return null;
      const [enriched] = await attachRelations(client, rows);
      return enriched;
    });
    if (!product) return fail(res, 'Product not found', 404);
    return ok(res, product);
  } catch (err) {
    return fail(res, 'Product not found', 404);
  }
});

// GET /products/:id
router.get('/:id', async (req, res) => {
  try {
    const product = await withTenant(req.user.tenant_schema, async (client) => {
      const { rows } = await client.query('select * from products where id = $1', [req.params.id]);
      if (!rows[0]) return null;
      const [enriched] = await attachRelations(client, rows);
      return enriched;
    });
    if (!product) return fail(res, 'Product not found', 404);
    return ok(res, product);
  } catch (err) {
    return fail(res, err.message, 404);
  }
});

// POST /products — with optional image upload
router.post('/', requireMinRole('staff'), upload.single('image'), async (req, res) => {
  const { name, sku, barcode, category_id, description, unit, low_stock_threshold } = req.body;
  if (!name || !sku) return fail(res, 'name and sku are required');

  let image_url = null;
  if (req.file) {
    const ext = req.file.mimetype === 'image/jpeg' ? 'jpg' : req.file.mimetype.split('/')[1];
    const fileName = `${req.user.tenant_schema}/products/${sku}-${Date.now()}.${ext}`;
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from('product-images')
      .upload(fileName, req.file.buffer, { contentType: req.file.mimetype, upsert: true });
    if (uploadError) return fail(res, `Image upload failed: ${uploadError.message}`);
    const { data: urlData } = supabase.storage.from('product-images').getPublicUrl(uploadData.path);
    image_url = urlData.publicUrl;
  }

  try {
    const product = await withTenant(req.user.tenant_schema, req.user.id, async (client) => {
      const { rows } = await client.query(
        `insert into products (name, sku, barcode, category_id, description, unit, low_stock_threshold, image_url)
         values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
        [name, sku, barcode || null, category_id || null, description || null, unit || 'pcs', Number(low_stock_threshold) || 10, image_url]
      );
      const [enriched] = await attachRelations(client, rows);
      return enriched;
    });
    return ok(res, product, 201);
  } catch (err) {
    if (err.code === '23505') return fail(res, 'A product with this SKU already exists');
    return fail(res, err.message);
  }
});

// PUT /products/:id
router.put('/:id', requireMinRole('staff'), upload.single('image'), async (req, res) => {
  const { name, sku, barcode, category_id, description, unit, low_stock_threshold, is_active, image_url } = req.body;

  let newImageUrl;
  if (req.file) {
    const ext2 = req.file.mimetype === 'image/jpeg' ? 'jpg' : req.file.mimetype.split('/')[1];
    const fileName = `${req.user.tenant_schema}/products/${sku || req.params.id}-${Date.now()}.${ext2}`;
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from('product-images')
      .upload(fileName, req.file.buffer, { contentType: req.file.mimetype, upsert: true });
    if (!uploadError) {
      const { data: urlData } = supabase.storage.from('product-images').getPublicUrl(uploadData.path);
      newImageUrl = urlData.publicUrl;
    }
  } else if (image_url !== undefined) {
    newImageUrl = image_url; // client sent back the existing image URL — preserve it
  }

  try {
    const product = await withTenant(req.user.tenant_schema, req.user.id, async (client) => {
      const { rows } = await client.query(
        `update products set
           name = coalesce($2, name),
           sku = coalesce($3, sku),
           barcode = coalesce($4, barcode),
           category_id = coalesce($5, category_id),
           description = coalesce($6, description),
           unit = coalesce($7, unit),
           low_stock_threshold = coalesce($8, low_stock_threshold),
           is_active = coalesce($9, is_active),
           image_url = coalesce($10, image_url)
         where id = $1 returning *`,
        [
          req.params.id,
          name ?? null,
          sku ?? null,
          barcode ?? null,
          category_id ?? null,
          description ?? null,
          unit ?? null,
          low_stock_threshold !== undefined ? Number(low_stock_threshold) : null,
          is_active === undefined ? null : (is_active === true || is_active === 'true'),
          newImageUrl ?? null,
        ]
      );
      if (!rows[0]) return null;
      const [enriched] = await attachRelations(client, rows);
      return enriched;
    });
    if (!product) return fail(res, 'Product not found', 404);
    return ok(res, product);
  } catch (err) {
    return fail(res, err.message);
  }
});

// DELETE /products/:id — admin only (soft delete / archive)
router.delete('/:id', requireRole('admin'), async (req, res) => {
  try {
    await withTenant(req.user.tenant_schema, req.user.id, async (client) => {
      await client.query('update products set is_active = false where id = $1', [req.params.id]);
    });
    return ok(res, { archived: true });
  } catch (err) {
    return fail(res, err.message);
  }
});

module.exports = router;
