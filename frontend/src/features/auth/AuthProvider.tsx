import { createContext, useContext, useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { apiClient } from '../../api/client';
import type { AuthSnapshot } from './auth.types';

const AuthContext = createContext<AuthSnapshot | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const snapshot = useSyncExternalStore(apiClient.subscribe, apiClient.getSnapshot);
  useEffect(() => { void apiClient.restore(); }, []);
  return <AuthContext.Provider value={snapshot}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth requires AuthProvider');
  return { ...context, login: apiClient.login.bind(apiClient), logout: apiClient.logout.bind(apiClient), retry: () => apiClient.restore() };
}
