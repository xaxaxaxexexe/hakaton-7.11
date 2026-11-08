import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { api } from './api';
import type { Cinema, Health } from './types';

const AppContext = createContext<{ cinemas: Cinema[]; mode: Health['mode'] | null; loading: boolean; error: string; reload: () => void }>({ cinemas: [], mode: null, loading: true, error: '', reload: () => {} });
export function AppProvider({ children }: { children: ReactNode }) {
  const [cinemas, setCinemas] = useState<Cinema[]>([]);
  const [mode, setMode] = useState<Health['mode'] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    Promise.all([api.cinemas(controller.signal), api.health(controller.signal).catch(() => null)])
      .then(([data, health]) => { if (!controller.signal.aborted) { setCinemas(data.items); setMode(health?.mode ?? null); } })
      .catch((e: Error) => { if (!controller.signal.aborted) setError(e.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [version]);
  return <AppContext.Provider value={{ cinemas, mode, loading, error, reload: () => setVersion(v => v + 1) }}>{children}</AppContext.Provider>;
}
export const useApp = () => useContext(AppContext);
