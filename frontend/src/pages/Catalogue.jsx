// Storefront (W1 step 0): GET /api/products — only active products of
// KYC-verified vendors. Search / vendor / price filters and paging run in SQL
// on the backend; filter state lives in the URL so refresh and back work.
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Empty, ErrorBox, Money, Notice, Pager, Spinner } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { parseRupees } from '../lib/money.js';
import { useApi } from '../lib/useApi.js';
import { MAX_QTY, useCart } from '../state/cart.jsx';

const PAGE_SIZE = 12;

function ProductCard({ product }) {
  const cart = useCart();
  const [qty, setQty] = useState(1);
  const [msg, setMsg] = useState(null);
  const inCart = cart.items.find((i) => i.product_id === product.product_id)?.quantity ?? 0;

  function add() {
    const r = cart.add(product, qty);
    setMsg(r.capped
      ? { tone: 'warn', text: `Capped at ${MAX_QTY} per order (added ${r.added}).` }
      : { tone: 'success', text: `Added ${r.added}.` });
  }

  return (
    <div className="card flex flex-col" data-testid="product-card">
      <p className="font-medium" data-testid="product-name">{product.name}</p>
      <p className="text-xs text-slate-500">{product.vendor_name}</p>
      <p className="mt-2 text-lg font-semibold"><Money paise={product.price_paise} /></p>
      <div className="mt-auto flex items-end gap-2 pt-3">
        <div className="w-20">
          <label className="label" htmlFor={`qty-${product.product_id}`}>Qty</label>
          <input id={`qty-${product.product_id}`} className="input" type="number" min={1} max={MAX_QTY} value={qty}
            onChange={(e) => setQty(Math.max(1, Math.min(MAX_QTY, Math.trunc(Number(e.target.value)) || 1)))} />
        </div>
        <button type="button" className="btn-primary flex-1" disabled={inCart >= MAX_QTY} onClick={add}>
          {inCart >= MAX_QTY ? 'Limit reached' : 'Add to cart'}
        </button>
      </div>
      {inCart > 0 && <p className="mt-2 text-xs text-slate-500">In cart: {inCart}</p>}
      {msg && <p className={`mt-1 text-xs ${msg.tone === 'warn' ? 'text-amber-700' : 'text-emerald-700'}`}>{msg.text}</p>}
    </div>
  );
}

export default function Catalogue() {
  const [params, setParams] = useSearchParams();
  const page = Math.max(1, Number.parseInt(params.get('page') || '1', 10) || 1);
  const q = params.get('q') ?? '';
  const vendorId = params.get('vendor') ?? '';
  const sort = params.get('sort') ?? 'name';
  const minText = params.get('min') ?? '';
  const maxText = params.get('max') ?? '';

  // the search box updates the URL 300 ms after typing stops
  const [qInput, setQInput] = useState(q);
  useEffect(() => { setQInput(q); }, [q]);
  useEffect(() => {
    if (qInput === q) return undefined;
    const t = setTimeout(() => update({ q: qInput }), 300);
    return () => clearTimeout(t);
  });

  function update(changes) {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(changes)) if (v) next.set(k, v); else next.delete(k);
    if (!('page' in changes)) next.delete('page');
    setParams(next, { replace: true });
  }

  const minPaise = minText ? parseRupees(minText) : null;
  const maxPaise = maxText ? parseRupees(maxText) : null;
  const priceError = (minText && minPaise === null) || (maxText && maxPaise === null)
    ? 'Prices must be rupee amounts like 499 or 1250.50.' : null;

  const vendors = useApi(() => api.get('/vendors'), []);
  const products = useApi(() => (priceError ? Promise.resolve(null) : api.get('/products', {
    q: q || undefined,
    vendor_id: vendorId || undefined,
    min_price_paise: minPaise && minPaise !== '0' ? minPaise : undefined,
    max_price_paise: maxPaise && maxPaise !== '0' ? maxPaise : undefined,
    sort, page, page_size: PAGE_SIZE,
  })), [q, vendorId, sort, page, minPaise, maxPaise, priceError]);

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Shop</h1>
      <div className="card grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <div className="lg:col-span-2">
          <label className="label" htmlFor="search">Search products or vendors</label>
          <input id="search" className="input" placeholder="e.g. lamp" value={qInput} maxLength={100}
            onChange={(e) => setQInput(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="vendor">Vendor</label>
          <select id="vendor" className="input" value={vendorId} onChange={(e) => update({ vendor: e.target.value })}>
            <option value="">All verified vendors</option>
            {vendors.data?.items.map((v) => <option key={v.vendor_id} value={v.vendor_id}>{v.legal_name}</option>)}
          </select>
        </div>
        <div className="flex gap-2">
          <div>
            <label className="label" htmlFor="min">Min ₹</label>
            <input id="min" className="input" inputMode="decimal" defaultValue={minText}
              onBlur={(e) => update({ min: e.target.value.trim() })} />
          </div>
          <div>
            <label className="label" htmlFor="max">Max ₹</label>
            <input id="max" className="input" inputMode="decimal" defaultValue={maxText}
              onBlur={(e) => update({ max: e.target.value.trim() })} />
          </div>
        </div>
        <div>
          <label className="label" htmlFor="sort">Sort</label>
          <select id="sort" className="input" value={sort} onChange={(e) => update({ sort: e.target.value })}>
            <option value="name">Name</option>
            <option value="price_asc">Price: low to high</option>
            <option value="price_desc">Price: high to low</option>
            <option value="newest">Newest</option>
          </select>
        </div>
      </div>

      {priceError && <Notice tone="warn">{priceError}</Notice>}
      <ErrorBox error={vendors.error} title="Could not load vendors" onRetry={vendors.reload} />
      <ErrorBox error={products.error} title="Could not load products" onRetry={products.reload} />
      {products.loading && <Spinner label="Loading products…" />}
      {!products.loading && products.data && (products.data.items.length === 0 ? (
        <Empty title="No products match these filters">Try a different search or clear the price range.</Empty>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {products.data.items.map((p) => <ProductCard key={p.product_id} product={p} />)}
          </div>
          <Pager page={page} pageSize={PAGE_SIZE} total={products.data.total} onPage={(n) => update({ page: String(n) })} />
        </>
      ))}
    </div>
  );
}
