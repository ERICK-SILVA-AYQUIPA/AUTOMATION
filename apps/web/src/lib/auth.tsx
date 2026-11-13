'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { api, refreshAccessToken, setAccessChangedHandler, setAccessToken, setSessionExpiredHandler } from './api';
import type { Me } from './types';

interface AuthState {
  me: Me | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<Me>;
  logout: () => Promise<void>;
  reload: () => Promise<void>;
  can: (permission: string) => boolean;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  const reload = useCallback(async () => {
    setMe(await api<Me>('/auth/me'));
  }, []);

  useEffect(() => {
    setSessionExpiredHandler(() => {
      setMe(null);
      router.replace('/login?expirada=1');
    });
    // Restaura la sesión desde la cookie de refresh, si existe
    (async () => {
      try {
        if (await refreshAccessToken()) await reload();
      } catch {
        setMe(null);
      } finally {
        setLoading(false);
      }
    })();
  }, [reload, router]);

  // El estado de la cuenta (vencimiento, módulos, activación) puede cambiar con la
  // sesión abierta: se vuelve a leer al volver a la pestaña, cada 5 minutos y
  // en cuanto la API responde que el acceso cambió.
  const signedIn = !!me;
  useEffect(() => {
    if (!signedIn) return;
    let last = Date.now();
    const refresh = (force = false) => {
      if (!force && Date.now() - last < 60_000) return;
      last = Date.now();
      reload().catch(() => undefined);
    };
    const onVisible = () => document.visibilityState === 'visible' && refresh();
    setAccessChangedHandler(() => refresh(true));
    document.addEventListener('visibilitychange', onVisible);
    const timer = setInterval(() => document.visibilityState === 'visible' && refresh(true), 5 * 60_000);
    return () => {
      setAccessChangedHandler(null);
      document.removeEventListener('visibilitychange', onVisible);
      clearInterval(timer);
    };
  }, [signedIn, reload]);

  const login = useCallback(async (email: string, password: string) => {
    const r = await api<{ accessToken: string }>('/auth/login', { method: 'POST', body: { email, password } });
    setAccessToken(r.accessToken);
    const m = await api<Me>('/auth/me');
    setMe(m);
    return m;
  }, []);

  const logout = useCallback(async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
    setAccessToken(null);
    setMe(null);
    router.replace('/login');
  }, [router]);

  const value = useMemo<AuthState>(
    () => ({ me, loading, login, logout, reload, can: (p) => !!me?.permissions.includes(p) }),
    [me, loading, login, logout, reload],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useAuth fuera de AuthProvider');
  return c;
}

/** Moneda de la empresa del usuario (para formatear importes) */
export const useCurrency = () => useAuth().me?.tenant?.currency ?? 'PEN';
