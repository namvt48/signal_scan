// Chain union shared between frontend and server (kept in sync with src/types.ts).

export const CHAINS = ['sol'] as const;
export type Chain = (typeof CHAINS)[number];
