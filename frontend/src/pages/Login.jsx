import { useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { ErrorBox } from '../components/ui.jsx';
import { useAuth } from '../state/auth.jsx';

export default function Login() {
  const { user, login } = useAuth();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  if (user) return <Navigate to={location.state?.from ?? '/'} replace />;

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <form onSubmit={submit} className="card w-full max-w-sm space-y-4">
        <div>
          <h1 className="text-xl font-bold text-indigo-700">PayRail</h1>
          <p className="text-sm text-slate-500">Sign in to the marketplace</p>
        </div>
        <div>
          <label className="label" htmlFor="email">Email</label>
          <input id="email" className="input" type="email" autoComplete="username" required
            value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="password">Password</label>
          <input id="password" className="input" type="password" autoComplete="current-password" required
            value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <ErrorBox error={error} title="Sign-in failed" />
        <button type="submit" className="btn-primary w-full" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        <p className="text-xs text-slate-500">
          Local demo accounts (seeded): <span className="font-mono">customer1@payrail.demo</span>,{' '}
          <span className="font-mono">vendor1@payrail.demo</span>, <span className="font-mono">finance@payrail.demo</span>{' '}
          — password <span className="font-mono">PayRail@2026</span>.
        </p>
      </form>
    </div>
  );
}
