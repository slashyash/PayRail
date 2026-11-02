// useApi(fn, deps): run a GET when deps change; exposes { data, error, loading, reload }.
// Stale responses (deps changed while a request was in flight) are ignored.
import { useCallback, useEffect, useRef, useState } from 'react';

export function useApi(fn, deps) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const seq = useRef(0);
  const run = useCallback(fn, deps);

  const load = useCallback(async () => {
    const my = ++seq.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await run();
      if (my === seq.current) setState({ data, error: null, loading: false });
    } catch (error) {
      if (my === seq.current) setState((s) => ({ ...s, error, loading: false }));
    }
  }, [run]);

  useEffect(() => { load(); }, [load]);
  return { ...state, reload: load };
}
