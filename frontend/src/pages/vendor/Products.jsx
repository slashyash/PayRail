// Vendor catalogue management — the CRUD part of the project (DEC-014).
// Products are NON-financial data, so they can be created, edited, archived and
// (only while no order line references them) deleted:
//   GET    /api/vendor/products?include_archived=1
//   POST   /api/vendor/products         { name, price_paise, is_active }
//   PATCH  /api/vendor/products/:id     { name?, price_paise?, is_active? }
//   DELETE /api/vendor/products/:id     → 204, or 409 "referenced" (FK from order_items)
// Past orders keep their purchase-time price snapshot; editing the price only
// affects future orders. Deleting a product that has order history is refused
// by the database's foreign key — the UI lets you try, to show that refusal.
import { useState } from 'react';
import { Empty, ErrorBox, Money, Notice, Pager, Spinner, StatusBadge, formatDateTime } from '../../components/ui.jsx';
import { api } from '../../lib/api.js';
import { paiseToInput, parseRupees } from '../../lib/money.js';
import { useApi } from '../../lib/useApi.js';

const PAGE_SIZE = 15;

function priceProblem(text) {
  const p = parseRupees(text);
  if (p === null || p === '0') return 'Enter a price in rupees, e.g. 499 or 1,250.50';
  return null;
}

function CreateForm({ onCreated }) {
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [active, setActive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const problem = !name.trim() ? 'A name is required.' : priceProblem(price);

  async function submit(e) {
    e.preventDefault();
    if (problem) return;
    setBusy(true);
    setError(null);
    try {
      const p = await api.post('/vendor/products', { name: name.trim(), price_paise: parseRupees(price), is_active: active });
      setName(''); setPrice(''); setActive(true);
      onCreated(p);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="card space-y-3" data-testid="product-create">
      <h2 className="font-medium">Add a product</h2>
      <div className="grid gap-3 sm:grid-cols-4">
        <div className="sm:col-span-2">
          <label className="label" htmlFor="np-name">Name</label>
          <input id="np-name" className="input" maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="np-price">Price (₹)</label>
          <input id="np-price" className="input" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
        </div>
        <label className="flex items-end gap-2 pb-2 text-sm">
          <input type="checkbox" checked={!active} onChange={(e) => setActive(!e.target.checked)} />
          Save as draft (not for sale)
        </label>
      </div>
      {name && price && problem && <p className="text-sm text-amber-700">{problem}</p>}
      <button type="submit" className="btn-primary" disabled={busy || !!problem}>{busy ? 'Saving…' : 'Add product'}</button>
      <ErrorBox error={error} title="Product not created" />
    </form>
  );
}

function EditRow({ p, onSaved, onCancel }) {
  const [name, setName] = useState(p.name);
  const [price, setPrice] = useState(paiseToInput(p.price_paise));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const problem = !name.trim() ? 'A name is required.' : priceProblem(price);

  async function save() {
    if (problem) return;
    const body = {};
    if (name.trim() !== p.name) body.name = name.trim();
    if (parseRupees(price) !== p.price_paise) body.price_paise = parseRupees(price);
    if (Object.keys(body).length === 0) { onCancel(); return; }
    setBusy(true);
    setError(null);
    try {
      onSaved(await api.patch(`/vendor/products/${p.product_id}`, body));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr className="border-t border-slate-100 bg-indigo-50/50" data-testid="product-edit">
      <td className="td">#{p.product_id}</td>
      <td className="td"><input aria-label="Product name" className="input" maxLength={200} value={name} onChange={(e) => setName(e.target.value)} /></td>
      <td className="td"><input aria-label="Price in rupees" className="input text-right" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} /></td>
      <td className="td" colSpan={3}>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn-primary" disabled={busy || !!problem} onClick={save}>Save</button>
          <button type="button" className="btn-secondary" onClick={onCancel}>Cancel</button>
          {problem && <span className="text-xs text-amber-700">{problem}</span>}
          {p.has_orders && <span className="text-xs text-slate-500">Past orders keep their snapshot price.</span>}
        </div>
        <ErrorBox error={error} title="Not saved" />
      </td>
    </tr>
  );
}

export default function Products() {
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);
  const list = useApi(() => api.get('/vendor/products', { include_archived: 1, page, page_size: PAGE_SIZE }), [page]);

  async function act(p, label, fn, okText) {
    setBusyId(p.product_id);
    setError(null);
    setMessage(null);
    try {
      await fn();
      setMessage(okText);
      list.reload();
    } catch (err) {
      setError({ err, label });
    } finally {
      setBusyId(null);
    }
  }

  const setActive = (p, isActive) => act(p, isActive ? 'reactivate' : 'archive',
    () => api.patch(`/vendor/products/${p.product_id}`, { is_active: isActive }),
    `“${p.name}” ${isActive ? 'is for sale again' : 'archived — it no longer appears in the shop; order history is unchanged'}.`);

  const remove = (p) => {
    const warn = p.has_orders
      ? `“${p.name}” appears in past orders. The database will refuse to delete it (foreign key from order_items) — archive it instead. Try anyway?`
      : `Delete “${p.name}” permanently? It has never been ordered.`;
    if (!window.confirm(warn)) return;
    act(p, 'delete', () => api.del(`/vendor/products/${p.product_id}`), `“${p.name}” deleted.`);
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Products</h1>
        <p className="text-sm text-slate-600">
          Archive a product to stop selling it. Only products that were never ordered can be deleted — order history is
          financial history and the database keeps it.
        </p>
      </div>
      <CreateForm onCreated={(p) => { setMessage(`“${p.name}” added${p.is_active ? '' : ' as a draft'}.`); setError(null); setPage(1); list.reload(); }} />
      {message && <Notice tone="success">{message}</Notice>}
      {error && <ErrorBox error={error.err} title={`Could not ${error.label}`} />}
      <ErrorBox error={list.error} title="Could not load products" onRetry={list.reload} />
      {list.loading && !list.data && <Spinner label="Loading products…" />}
      {list.data && (list.data.items.length === 0 ? <Empty title="No products yet">Add your first product above.</Empty> : (
        <div className="card overflow-x-auto p-0">
          <table className="w-full">
            <thead><tr>
              <th className="th">Id</th><th className="th">Name</th><th className="th num">Price</th>
              <th className="th">Status</th><th className="th">Created</th><th className="th">Actions</th>
            </tr></thead>
            <tbody>
              {list.data.items.map((p) => (editing === p.product_id ? (
                <EditRow key={p.product_id} p={p} onCancel={() => setEditing(null)}
                  onSaved={(np) => { setEditing(null); setMessage(`“${np.name}” saved.`); list.reload(); }} />
              ) : (
                <tr key={p.product_id} className="border-t border-slate-100" data-testid="product-row" data-product-id={p.product_id}>
                  <td className="td">#{p.product_id}</td>
                  <td className="td">
                    {p.name}
                    {p.has_orders && <span className="ml-2 text-xs text-slate-400">ordered</span>}
                  </td>
                  <td className="td num"><Money paise={p.price_paise} /></td>
                  <td className="td"><StatusBadge status={p.is_active ? 'active' : 'archived'} /></td>
                  <td className="td">{formatDateTime(p.created_at)}</td>
                  <td className="td">
                    <div className="flex flex-wrap gap-1">
                      <button type="button" className="btn-secondary" disabled={busyId === p.product_id} onClick={() => setEditing(p.product_id)}>Edit</button>
                      {p.is_active
                        ? <button type="button" className="btn-secondary" disabled={busyId === p.product_id} onClick={() => setActive(p, false)}>Archive</button>
                        : <button type="button" className="btn-secondary" disabled={busyId === p.product_id} onClick={() => setActive(p, true)}>Reactivate</button>}
                      <button type="button" className="btn-secondary text-rose-700" disabled={busyId === p.product_id} onClick={() => remove(p)}>Delete</button>
                    </div>
                  </td>
                </tr>
              )))}
            </tbody>
          </table>
        </div>
      ))}
      {list.data && <Pager page={page} pageSize={PAGE_SIZE} total={list.data.total} onPage={setPage} />}
    </div>
  );
}
