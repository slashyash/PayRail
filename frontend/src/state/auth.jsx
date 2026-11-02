// Login state. The JWT is kept in localStorage so a refresh keeps the session;
// on start-up it is checked with GET /api/auth/me (the backend re-reads the
// user from the database on every request). Any 401 logs the user out.
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, setToken, setUnauthenticatedHandler } from '../lib/api.js';

const TOKEN_KEY = 'payrail.token';
const AuthContext = createContext(null);

function readToken() {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}
function writeToken(t) {
  try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(true);
  // 'signout' = the user pressed "Log out"; 'expired' = token refused (401). Only after an
  // expiry does the login page send the user back to the page they were on.
  const [loggedOutBy, setLoggedOutBy] = useState(null);

  const logout = useCallback((reason = 'expired') => {
    writeToken(null);
    setToken(null);
    setUser(null);
    setLoggedOutBy(reason);
  }, []);

  // Restore a saved session. Only a 401 discards the token: if the server is
  // unreachable the token is kept and the UI offers a retry instead of logging out.
  const [sessionError, setSessionError] = useState(null);
  const restore = useCallback(() => {
    const t = readToken();
    if (!t) { setChecking(false); return; }
    setToken(t);
    setChecking(true);
    setSessionError(null);
    api.get('/auth/me')
      .then(setUser)
      .catch((e) => { if (e.status === 401) logout('expired'); else setSessionError(e); })
      .finally(() => setChecking(false));
  }, [logout]);

  useEffect(() => {
    setUnauthenticatedHandler(() => logout('expired'));
    restore();
  }, [logout, restore]);

  const login = useCallback(async (email, password) => {
    const r = await api.post('/auth/login', { email, password });
    writeToken(r.token);
    setToken(r.token);
    setUser(r.user);
    setLoggedOutBy(null);
    return r.user;
  }, []);

  const value = useMemo(() => ({ user, checking, sessionError, restore, loggedOutBy, login, logout }),
    [user, checking, sessionError, restore, loggedOutBy, login, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
