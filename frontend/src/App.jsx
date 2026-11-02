// Routes. The backend enforces every role/ownership rule; these guards only
// keep the UI coherent (a vendor never sees the customer pages, etc.).
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import Layout from './components/Layout.jsx';
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
import StaffHome from './pages/StaffHome.jsx';
import { useAuth } from './state/auth.jsx';

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
  const home = { customer: '/shop', finance_admin: '/finance/gateway' }[user.role] ?? '/staff';
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
          <Route element={<RequireRole role="finance_admin" />}>
            <Route path="finance/gateway" element={<GatewaySimulator />} />
          </Route>
          <Route path="staff" element={<StaffHome />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Route>
    </Routes>
  );
}
