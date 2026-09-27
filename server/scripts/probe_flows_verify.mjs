// probe_flows_verify.mjs — empirical contract check for POST https://api.nansen.ai/api/v1/tgm/flows
// usage: NANSEN_API_KEY=xxx node server/scripts/probe_flows_verify.mjs <CA> [chain]
// chain defaults to solana. 7 calls total (1 credit each). No imports, Node 18+ global fetch.
const KEY = process.env.NANSEN_API_KEY;
const CA = process.argv[2];
const CHAIN = process.argv[3] || 'solana';
if (!KEY) { console.log('NANSEN_API_KEY not set'); process.exit(1); }
if (!CA) { console.log('usage: NANSEN_API_KEY=... node probe_flows_verify.mjs <CA> [chain]'); process.exit(1); }

const URL = 'https://api.nansen.ai/api/v1/tgm/flows';
const DAY = 86_400_000;
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const body = (from, to, label, page = 1, per_page = 100) => ({
  chain: CHAIN, token_address: CA, date: { from: iso(from), to: iso(to) }, label, pagination: { page, per_page },
});

async function call(req) {
  let res;
  try {
    res = await fetch(URL, { method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(req) });
  } catch (e) { console.log(`  network error: ${String(e).slice(0, 200)}`); return { status: 0, rows: [], warnings: undefined, raw: '' }; }
  const text = await res.text().catch(() => '');
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, credits: res.headers.get('x-nansen-credits-remaining'), rows: Array.isArray(json?.data) ? json.data : [], warnings: json?.warnings, raw: text };
}
async function probe(name, req) {
  console.log(`\n=== ${name} ===`);
  console.log(`  req: ${JSON.stringify(req)}`);
  const r = await call(req);
  const first = r.rows[0], last = r.rows[r.rows.length - 1];
  console.log(`  HTTP ${r.status}  credits=${r.credits ?? 'n/a'}  rows=${r.rows.length}`);
  if (r.status !== 200) console.log(`  body: ${String(r.raw).slice(0, 300)}`);
  else {
    if (first) console.log(`  keys: ${Object.keys(first).join(',')}`);
    console.log(`  first date=${first?.date ?? '-'}  last date=${last?.date ?? '-'}`);
    if (r.warnings !== undefined) console.log(`  warnings: ${JSON.stringify(r.warnings).slice(0, 200)}`);
  }
  return r;
}
const medGapMs = (rows) => {
  const ts = [...new Set(rows.map((r) => r.date))].map(Date.parse).filter(Number.isFinite).sort((a, b) => a - b);
  if (ts.length < 2) return null;
  const g = ts.slice(1).map((t, i) => t - ts[i]).sort((a, b) => a - b);
  return g[Math.floor(g.length / 2)];
};
const gran = (ms) => (ms == null ? 'n/a' : ms >= DAY * 0.9 ? 'daily' : ms >= 3_600_000 * 0.9 ? 'hourly' : `${Math.round(ms / 60000)}m`);
const DEXCEX = ['total_inflows_dex', 'total_outflows_dex', 'total_inflows_cex', 'total_outflows_cex'];
const allNull = (rows) => (rows.length ? rows.every((r) => DEXCEX.every((f) => r[f] == null)) : null);
const anyNonNull = (rows) => rows.some((r) => DEXCEX.some((f) => r[f] != null));

console.log(`CA=${CA} chain=${CHAIN} window 7d=[${iso(now - 7 * DAY)}, ${iso(now)}]`);

const p1 = await probe('P1 7d label=top_100_holders per_page=100', body(now - 7 * DAY, now, 'top_100_holders'));
const p2 = await probe('P2 7d label=exchange per_page=100', body(now - 7 * DAY, now, 'exchange'));
const p1Null = allNull(p1.rows), p2Null = allNull(p2.rows);
console.log(`\nP2 check: DEX/CEX all-null in top_100_holders=${p1Null}  any-non-null in exchange=${anyNonNull(p2.rows)}`);
console.log(`  warnings present -> P1=${p1.warnings !== undefined} P2=${p2.warnings !== undefined}`);

const p3 = await probe('P3 30d label=top_100_holders per_page=100', body(now - 30 * DAY, now, 'top_100_holders'));
const gap30 = medGapMs(p3.rows);
console.log(`  median gap=${gap30 == null ? 'n/a' : Math.round(gap30 / 60000) + 'm'}  inferred granularity=${gran(gap30)}  (expect daily for >7d)`);

const p4a = await probe('P4a 7d per_page=1000', body(now - 7 * DAY, now, 'top_100_holders', 1, 1000));
const p4b = await probe('P4b 7d per_page=500', body(now - 7 * DAY, now, 'top_100_holders', 1, 500));

const p5 = await probe('P5 30d per_page=100 page=2', body(now - 30 * DAY, now, 'top_100_holders', 2, 100));
const pg1First = p3.rows[0]?.date ?? null, pg2First = p5.rows[0]?.date ?? null;
const pgReal = pg2First != null && pg2First !== pg1First;

const p6 = await probe('P6 5y window per_page=100', body(now - 5 * 365 * DAY, now, 'top_100_holders', 1, 100));
const earliest = p6.rows.map((r) => r.date).filter(Boolean).sort()[0] ?? null;

const p1ByDate = new Map(p1.rows.map((r) => [r.date, r.token_amount]));
let common = 0, diff = 0;
for (const r of p2.rows) if (p1ByDate.has(r.date)) { common++; if (p1ByDate.get(r.date) !== r.token_amount) diff++; }

console.log('\n===== VERDICT =====');
console.log(`bucket rule (hourly<=7d, daily>7d): 7d=${gran(medGapMs(p1.rows))} 30d=${gran(gap30)}`);
console.log(`exchange-only DEX/CEX fields: null-for-top_100=${p1Null} nonnull-for-exchange=${anyNonNull(p2.rows)}`);
console.log(`max accepted per_page: 1000->${p4a.status} 500->${p4b.status} (200=accepted, 4xx=rejected)`);
console.log(`pagination page=2 distinct from page=1: ${pgReal} (p1=${pg1First} p2=${pg2First} rows=${p5.rows.length})`);
console.log(`earliest servable date in 5y window: ${earliest ?? 'none'} (rows=${p6.rows.length})`);
console.log(`top_100_holders vs exchange parity: common_buckets=${common} token_amount_differ=${diff}${common ? ` (${((diff / common) * 100).toFixed(1)}%)` : ''}`);
