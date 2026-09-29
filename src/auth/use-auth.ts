import { useContext } from 'react';
import { AuthContext } from './auth-context-value';
import type { AuthContextValue } from './auth-context-value';

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
