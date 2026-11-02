// Catalogue (any authenticated user): only ACTIVE products of KYC-VERIFIED
// vendors are listed — the same rule trg_order_items_snapshot enforces when
// an order is placed.
import { Router } from 'express';
import { z } from 'zod';
import { notFound } from '../errors.js';
import { idString, offset, pageOf, pageQuery, paiseString, parseParams, parseQuery } from '../validate.js';

const likeEscape = (s) => s.replace(/[\\%_]/g, (c) => '\\' + c);

const SORTS = {
  name: 'p.name, p.product_id',
  price_asc: 'p.price_paise, p.product_id',
  price_desc: 'p.price_paise DESC, p.product_id',
  newest: 'p.created_at DESC, p.product_id DESC',
};

export function catalogueRoutes({ db }) {
  const r = Router();

  r.get('/products', async (req, res) => {
    const q = parseQuery(req, {
      ...pageQuery,
      q: z.string().trim().max(100).optional(),
      vendor_id: idString.optional(),
      min_price_paise: paiseString.optional(),
      max_price_paise: paiseString.optional(),
      sort: z.enum(Object.keys(SORTS)).default('name'),
    });
    const { rows } = await db.query(
      `SELECT p.product_id, p.name, p.price_paise, p.vendor_id, v.legal_name AS vendor_name,
              count(*) OVER () AS total_count
         FROM products p JOIN vendors v USING (vendor_id)
        WHERE p.is_active AND v.kyc_status = 'verified'
          AND ($1::text   IS NULL OR p.name ILIKE '%' || $1 || '%' OR v.legal_name ILIKE '%' || $1 || '%')
          AND ($2::bigint IS NULL OR p.vendor_id = $2)
          AND ($3::bigint IS NULL OR p.price_paise >= $3)
          AND ($4::bigint IS NULL OR p.price_paise <= $4)
        ORDER BY ${SORTS[q.sort]}
        LIMIT $5 OFFSET $6`,
      [q.q ? likeEscape(q.q) : null, q.vendor_id ?? null, q.min_price_paise ?? null, q.max_price_paise ?? null,
        q.page_size, offset(q)]);
    res.json(pageOf(rows, q));
  });

  r.get('/products/:id', async (req, res) => {
    const { id } = parseParams(req, { id: idString });
    const p = await db.one(
      `SELECT p.product_id, p.name, p.price_paise, p.vendor_id, v.legal_name AS vendor_name
         FROM products p JOIN vendors v USING (vendor_id)
        WHERE p.product_id = $1 AND p.is_active AND v.kyc_status = 'verified'`, [id]);
    if (!p) throw notFound('product');
    res.json(p);
  });

  r.get('/vendors', async (req, res) => {
    const { rows } = await db.query(
      `SELECT vendor_id, legal_name FROM vendors WHERE kyc_status = 'verified' ORDER BY legal_name, vendor_id`);
    res.json({ items: rows });
  });

  return r;
}
