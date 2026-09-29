// User-set per-CA tier vocabulary (dashboard Tier column), shared between the
// write boundary (api.ts) and the read side (db.ts / signals.ts).

export const TIERS = ['S+', 'S', 'A+', 'A', 'B+', 'B', 'P'] as const;
export type Tier = (typeof TIERS)[number];

export function isTier(v: unknown): v is Tier {
  return typeof v === 'string' && (TIERS as readonly string[]).includes(v);
}
