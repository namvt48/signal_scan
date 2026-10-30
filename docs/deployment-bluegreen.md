# Blue-green rollout boundary


## Standalone public API rollout

The public `/api/v1/*` service is blue-green as a unit: each slot contains the public API process plus two private export-only readers. The main reader uses instance A's SQLite database; the FOMO reader uses `PUBLIC_API_FOMO_DATA_DIR`, which defaults to A's database to preserve the current configured FOMO upstream. Set it to another live database only when the configured FOMO upstream reads that database. Both readers mount database files and the shared market-data volume read-only, run no pollers, and apply no schema migrations.

The candidate slot starts both readers, checks their container health, then `/readyz` performs authenticated real exports through them before Caddy switches traffic. The previous API and its readers remain running through cutover and smoke checks. Failure restores the prior Caddy route; if Caddy rollback fails, the routed candidate and both readers remain running.

This keeps public data routes available while either dashboard API process restarts, provided the host and SQLite files remain available. It does not protect against host, disk, shared-volume, or incompatible-schema failures. Keep migrations backward-compatible with the running export readers using expand-contract; a migration that drops or changes columns they query can still interrupt Public API reads.

The A/B dashboard backends remain single-instance. Do not use instance B as a replacement for A: they own separate databases. The public API readers follow the configured source directories and never substitute a stale B database for an active upstream. Readers open SQLite with `readonly`, set `query_only`, and never invoke the writer startup path.

## Backend deployment boundary

The production A API owns request handling, database writes, pollers, schedules, and startup migrations. It is not safe to run two writable backend releases against the same SQLite files. Public API uptime during backend deploys is provided by the separate read-only export readers; it does not make the dashboard backend itself blue-green.

The export readers' schema contract is part of every backend deploy. Add new schema before relying on it; retain the columns and tables queried by the active readers until those readers have been rolled forward. Do not run a destructive migration that breaks an active reader.

## First host-edge migration

The existing web service publishes `127.0.0.1:8124`, while host Caddy and host daemons use that port. A stable edge cannot bind `8124` until the legacy web releases it. The first migration therefore has a bounded host-port handoff interruption: keep host Caddy configuration unchanged, prepare candidate services on private Docker networking, stop only the legacy web listener immediately before starting the edge, verify the edge, then update/reload Caddy only if its upstream needs adjustment. Do not claim a zero-interruption bootstrap.

## Gate before dashboard backend blue-green

Dashboard API blue-green remains disabled until read and write paths are separated, the worker owns every poller/schedule and exclusive database writer lock, API instances open only read-only DB connections, unsafe migrations are rejected, readiness checks representative exports and release identity, and rollback can restore the prior writer without replaying dispatched mutations.

Until that gate is met, do not start a second dashboard backend against the live SQLite files. This does not block the standalone Public API rollout: it uses its own read-only data exporters and does not recreate either dashboard API.
