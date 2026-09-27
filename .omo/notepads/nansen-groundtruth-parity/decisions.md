# decisions - nansen-groundtruth-parity

## [T6] price universe scoped to SELECTED groups
capture_prices universe = ca(selected groups) ∪ {WSOL} ∪ balance-mints(selected cached
txs) — a --limit/--sigs run NEVER fetches prices for the other groups' CAs (per T6 MUST
DO). Todo 8 full run grows prices.json organically via the same cache-first path.

## [T6] seed_prices does NOT seed _info_miss (deviation from trace22)
Miss markers expire after 60s TTL → token_info re-fetches → hermetic `network calls: 0`
would rot over time. Parity harness seeds px=0 entries as permanent cache hits.

## [T6] CLI --seed = price snapshot PATH (default .probe/nansen-parity/prices.json);
## run() default --out = .probe/nansen-parity/smoke (top-level paths reserved for todo 8).

## [T6] classify 2-pass in run(): drift=None → drift=median(raw) → reclassify (G9
## "after one global drift factor"); TRACE_REQUIRED-with-empty-trace gets honest
## placeholder line instead of crash or gate weakening.

## [T6-FIX] --seed = int RNG seed; price snapshot path = --prices (default prices.json)
## [T6-FIX] --sigs token = PREFIX match (superset of exact); unknown-token warning now
reports tokens matching no sig in truth. --limit ordering semantics with --sigs UNCHANGED.
## [T6-FIX] select_sigs(pop, sigs, limit, seed) is the single selection code path for
run() and is unit-testable offline; seeded sample returns sorted(sample(...)) — same SET
as plan's random.Random(seed).sample(sorted(sigs), N), deterministic order for fetching.
