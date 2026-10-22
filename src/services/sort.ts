import type { FomoUser, Wallet } from '../types';

export function byName(a: Wallet, b: Wallet): number {
  return a.name.localeCompare(b.name, undefined, { numeric: true });
}

export function byHandle(a: FomoUser, b: FomoUser): number {
  return a.handle.localeCompare(b.handle, undefined, { numeric: true });
}
