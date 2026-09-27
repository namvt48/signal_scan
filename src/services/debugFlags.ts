import { useSyncExternalStore } from 'react';

const KEY = 'signal_scan:allFactors';
const listeners = new Set<() => void>();
let mem = false; // fallback when sessionStorage is blocked (private mode)

export function getAllFactors(): boolean {
  try {
    return sessionStorage.getItem(KEY) === '1';
  } catch {
    return mem;
  }
}

export function setAllFactors(on: boolean): void {
  mem = on;
  try {
    sessionStorage.setItem(KEY, on ? '1' : '0');
  } catch {
    // storage blocked: keep working in-memory for this page
  }
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** Per-tab session debug flag — never persisted server-side, cleared when the tab closes. */
export function useAllFactors(): boolean {
  return useSyncExternalStore(subscribe, getAllFactors);
}
