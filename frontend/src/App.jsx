// Routes. The backend enforces every role/ownership rule; these guards only
// keep the UI coherent (a vendor never sees the customer pages, etc.).
import { lazy, Suspense } from 'react';
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import Layout from './components/Layout.jsx';
import Trace from './pages/finance/Trace.jsx';
import Overview from './pages/finance/Overview.jsx';
import Record from './pages/finance/Record.jsx';
import { ErrorBox, Spinner } from './components/ui.jsx';
import Cart from './pages/Cart.jsx';
import Catalogue from './pages/Catalogue.jsx';
import GatewayCheckout from './pages/GatewayCheckout.jsx';
import GatewaySimulator from './pages/GatewaySimulator.jsx';
import Login from './pages/Login.jsx';
import OrderDetail from './pages/OrderDetail.jsx';
import Orders from './pages/Orders.jsx';
import Pay from './pages/Pay.jsx';
import Refunds from './pages/Refunds.jsx';
import FinancePayouts from './pages/finance/Payouts.jsx';
import Reconciliation from './pages/finance/Reconciliation.jsx';
import FinanceRefunds from './pages/finance/Refunds.jsx';
import Settlements from './pages/finance/Settlements.jsx';
import TrialBalance from './pages/finance/TrialBalance.jsx';
import Products from './pages/vendor/Products.jsx';
import VendorPayouts from './pages/vendor/Payouts.jsx';
import Statement from './pages/vendor/Statement.jsx';
import VendorHome from './pages/vendor/VendorHome.jsx';
import { useAuth } from './state/auth.jsx';

// Recharts is large: load the report pages only when opened (own chunk)
const FinanceReports = lazy(() => import('./pages/finance/Reports.jsx'));
const VendorReports = lazy(() => import('./pages/vendor/Reports.jsx'));
const lazyPage = (el) => <Suspense fallback={<Spinner label="Loading report…" />}>{el}</Suspense>;

function RequireAuth() {
  const { user, checking, sessionError, restore, loggedOutBy } = useAuth();
  const location = useLocation();
  if (checking) return <div className="mx-auto max-w-6xl px-4"><Spinner label="Checking session…" /></div>;
  if (!user && sessionError) {
    return <div className="mx-auto max-w-xl px-4 py-10"><ErrorBox error={sessionError} title="Could not restore your session" onRetry={restore} /></div>;
  }
  if (!user) {
    const state = loggedOutBy === 'signout' ? undefined : { from: location.pathname + location.search };
    return <Navigate to="/login" replace state={state} />;
  }
  return <Outlet />;
}

function RequireRole({ role }) {
  const { user } = useAuth();
  return user.role === role ? <Outlet /> : <Navigate to="/" replace />;
}

function Home() {
  const { user } = useAuth();
  const home = { customer: '/shop', vendor_admin: '/vendor', finance_admin: '/finance' }[user.role] ?? '/login';
  return <Navigate to={home} replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={<RequireAuth />}>
        {/* the simulated gateway's hosted page: outside the shop layout, like an external site */}
        <Route element={<RequireRole role="customer" />}>
          <Route path="gateway/checkout/:paymentId" element={<GatewayCheckout />} />
        </Route>
        <Route element={<Layout />}>
          <Route index element={<Home />} />
          <Route element={<RequireRole role="customer" />}>
            <Route path="shop" element={<Catalogue />} />
            <Route path="cart" element={<Cart />} />
            <Route path="orders" element={<Orders />} />
            <Route path="orders/:orderId" element={<OrderDetail />} />
            <Route path="orders/:orderId/pay" element={<Pay />} />
            <Route path="refunds" element={<Refunds />} />
          </Route>
          <Route element={<RequireRole role="vendor_admin" />}>
            <Route path="vendor" element={<VendorHome />} />
            <Route path="vendor/products" element={<Products />} />
            <Route path="vendor/statement" element={<Statement />} />
            <Route path="vendor/payouts" element={<VendorPayouts />} />
            <Route path="vendor/reports" element={lazyPage(<VendorReports />)} />
          </Route>
          <Route element={<RequireRole role="finance_admin" />}>
            <Route path="finance/trace/:kind/:id" element={<Trace />} />
            <Route path="finance" element={<Overview />} />
            <Route path="finance/orders/:id" element={<Record />} />
            <Route path="finance/payouts/:id" element={<Record />} />
            <Route path="finance/refunds" element={<FinanceRefunds />} />
            <Route path="finance/payouts" element={<FinancePayouts />} />
            <Route path="finance/settlements" element={<Settlements />} />
            <Route path="finance/reconciliation" element={<Reconciliation />} />
            <Route path="finance/reports" element={lazyPage(<FinanceReports />)} />
            <Route path="finance/ledger" element={<TrialBalance />} />
            <Route path="finance/gateway" element={<GatewaySimulator />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Route>
    </Routes>
  );
}
