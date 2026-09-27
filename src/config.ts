/** 24h volume below this = cooldown over, entry available (docs/framework01-spec.md, column 9). */
export const ENTRY_VOLUME_THRESHOLD = 300_000;

/**
 * Clan is a per-deployment feature. The 2nd instance (clan-partitioned) builds with
 * VITE_SHOW_CLAN=on; instance a and local dev leave it unset, so the Clan column and
 * fields are omitted entirely. Baked at build time — see Dockerfile ARG + Makefile.
 */
export const SHOW_CLAN = import.meta.env.VITE_SHOW_CLAN === 'on';

/** Browser tab title. Instance b builds as "fomo"; local dev and instance a keep the repo name. */
export const APP_TITLE = import.meta.env.VITE_TITLE || 'signal_scan';
