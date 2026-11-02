import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../state/auth.jsx';
import { useCart } from '../state/cart.jsx';

const link = ({ isActive }) =>
  `rounded-md px-3 py-1.5 text-sm font-medium ${isActive ? 'bg-indigo-50 text-indigo-700' : 'text-slate-600 hover:bg-slate-100'}`;

export default function Layout() {
  const { user, logout } = useAuth();
  const cart = useCart();
  // explicit log-out → clean login page (the next user must not land on the previous user's page)
  const signOut = () => logout('signout');
  const isCustomer = user?.role === 'customer';
  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-4 py-3">
          <span className="mr-2 text-lg font-bold text-indigo-700">PayRail</span>
          {isCustomer && (
            <nav className="flex flex-wrap gap-1" aria-label="Main">
              <NavLink to="/shop" className={link}>Shop</NavLink>
              <NavLink to="/cart" className={link}>
                Cart{cart.count > 0 && <span data-testid="cart-count" className="ml-1 rounded-full bg-indigo-600 px-1.5 text-xs text-white">{cart.count}</span>}
              </NavLink>
              <NavLink to="/orders" className={link}>My orders</NavLink>
              <NavLink to="/refunds" className={link}>My refunds</NavLink>
            </nav>
          )}
          {user.role === 'vendor_admin' && (
            <nav className="flex flex-wrap gap-1" aria-label="Main">
              <NavLink to="/vendor" end className={link}>Dashboard</NavLink>
              <NavLink to="/vendor/products" className={link}>Products</NavLink>
              <NavLink to="/vendor/statement" className={link}>Statement</NavLink>
              <NavLink to="/vendor/payouts" className={link}>Payouts</NavLink>
            </nav>
          )}
          {user.role === 'finance_admin' && (
            <nav className="flex flex-wrap gap-1" aria-label="Main">
              <NavLink to="/finance/refunds" className={link}>Refunds</NavLink>
              <NavLink to="/finance/payouts" className={link}>Payouts</NavLink>
              <NavLink to="/finance/settlements" className={link}>Settlements</NavLink>
              <NavLink to="/finance/reconciliation" className={link}>Reconciliation</NavLink>
              <NavLink to="/finance/ledger" className={link}>Ledger</NavLink>
              <NavLink to="/finance/gateway" className={link}>Gateway simulator</NavLink>
            </nav>
          )}
          <div className="ml-auto flex items-center gap-3 text-sm">
            <span className="text-slate-600">
              {user.full_name}{user.vendor_name ? ` · ${user.vendor_name}` : ''} <span className="text-slate-400">({user.role.replace('_', ' ')})</span>
            </span>
            <button type="button" className="btn-secondary" onClick={signOut}>Log out</button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">
        <Outlet />
      </main>
      <footer className="mx-auto max-w-6xl px-4 pb-6 text-xs text-slate-400">
        Simulated payments only — no real money, gateway or bank. Amounts in INR.
      </footer>
    </div>
  );
}
