// Vendor and finance screens are Task 5. Until then, staff accounts land here.
import { Navigate } from 'react-router-dom';
import { useAuth } from '../state/auth.jsx';

export default function StaffHome() {
  const { user } = useAuth();
  if (user.role === 'customer') return <Navigate to="/shop" replace />;
  return (
    <div className="card max-w-xl space-y-2">
      <h1 className="text-lg font-semibold">Signed in as {user.role.replace('_', ' ')}</h1>
      {user.vendor_name && <p className="text-sm text-slate-600">Vendor: {user.vendor_name} (KYC {user.kyc_status})</p>}
      <p className="text-sm text-slate-600">
        The {user.role === 'vendor_admin' ? 'vendor' : 'finance'} screens are not built yet (Task 5)
        {user.role === 'finance_admin' && <>, except the <a className="text-indigo-700 underline" href="/finance/gateway">gateway simulator</a></>}.
        The API endpoints already exist — see <span className="font-mono">backend/README.md</span>.
      </p>
    </div>
  );
}
