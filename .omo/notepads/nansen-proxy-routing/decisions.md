# Decisions — nansen-proxy-routing

APPEND ONLY. Plan: `.omo/plans/nansen-proxy-routing.md` (§ Design decisions D1–D12).

- **D1** Door = 1 WS connection browserless + `--proxy-server` (query string) + `page.authenticate` khi có cred. browserless v1 = 1 browser/connection → N doors trong 1 container, egress IP + cookie jar + cf_clearance riêng.
- **D2** `CRAWL_PROXY_FILE` default `''`; mỗi dòng `http://user:pass@host:port`; bỏ `#`/blank; dòng lỗi → warn + skip. File thiếu/rỗng → fallback 1 door từ `CRAWL_WS_ENDPOINT`.
- **D3** States: cold → warming → probation → healthy → throttled → penalized → retired. warming = goto token-god-mode + poll title/cf_clearance mỗi 2.5s, timeout 30s + egress check (log only). 429 → throttled: quarantine retry-after + jitter ≤30s (thiếu header → 1800s). 403-real → penalized backoff 2m/10m/30m → retired.
- **D4** Classifier: 200+json=OK; 429=THROTTLE; 403+html=INTERSTITIAL; 403+json=REAL403; ≥500=5XX; throw/timeout/json-fail=TRANSPORT.
- **D5** OK→health; THROTTLE→quarantine+requery; INTERSTITIAL→re-warm+requery; REAL403→re-warm 1 lần, lặp→penalized, requery; 5XX→requery+transport-fail++; TRANSPORT→transport-fail++, ≥2 liên tiếp→retired, requery. **Requery ≤1 lần/request.**
- **D6** Budget per-(door,path) sliding window: CRAWL_PATH_BUDGET=30 / CRAWL_BUDGET_WINDOW_MS=60000; cap tổng per-door CRAWL_DOOR_CAP_PER_MIN=40.
- **D7** Router: least-outstanding trong doors eligible; cạn budget nhưng còn door sống → chờ slot (poll 250ms, cap 65s); hết door → {status:503,json:null} + log skip.
- **D8** pool.start() warmup song song, non-blocking; index.ts KHÔNG sửa.
- **D9** doors = max(ceil(total/door_cap), max_path ceil(path_demand/path_budget)) + 1 dự phòng.
- **D10** Log: [door <id>] <event> path=<p> status=<s> budget=<used>/<cap> outstanding=<n> state=<st>.
- **D11** Test seam: DoorPool inject {connect, now, sleep}; export thêm parseProxyFile, classify.
- **D12** Cadence repair (owner duyệt default): POLL_WALLETS_MS=5400000, POLL_HOT_MS=1800000, POLL_COLD_MS=7200000 — chỉ ghi doc/.env.example, KHÔNG đổi default config.ts.

## Invariants
- browserPostJson(url, body): Promise<{status, json}> giữ nguyên chữ ký + generic <T>.
- createCircuitBreaker vẫn export; server/test/crawl-breaker.test.ts phải pass.
- Không sửa: index.ts, poller.ts, providers/nansen.ts, api.ts, snapshot.ts, FE.
- Không dependency mới. Không git. Không deploy.

## T2/T3 FROZEN INTERFACE CONTRACT (authoritative — both workers MUST match exactly)

```ts
export interface ProxySpec { url: string; username?: string; password?: string }
export function parseProxyFile(text: string): ProxySpec[]
export type Classification = 'ok' | 'throttle' | 'interstitial' | 'real403' | '5xx' | 'transport'
export interface DoorHttpResponse {
  status: number; contentType: string; retryAfter: number | null;
  head: string; len: number; json: unknown | null; threw: boolean
}
export function classify(res: DoorHttpResponse): Classification
export interface DoorConn {
  fetch(url: string, body: unknown, timeoutMs: number): Promise<DoorHttpResponse>
  invalidate(): Promise<void>; close(): Promise<void>
}
export interface DoorSpec { ws: string; proxy: ProxySpec | null }
export interface DoorPoolConfig {
  wsEndpoint: string; proxies: ProxySpec[]; pathBudget: number; budgetWindowMs: number;
  doorCapPerMin: number; warmupTimeoutMs: number; requestTimeoutMs: number; quarantineJitterMs: number
}
export interface DoorPoolDeps {
  connect(spec: DoorSpec): Promise<DoorConn>
  now(): number; sleep(ms: number): Promise<void>
  config: DoorPoolConfig; log(line: string): void
}
export type DoorState = 'cold'|'warming'|'probation'|'healthy'|'throttled'|'penalized'|'retired'
export interface DoorStat {
  id: number; state: DoorState; proxy: string; egressIp: string | null;
  requests: number; lastStatus: number | null; budgetUsed: number; retiredReason: string | null
}
export class DoorPool {
  constructor(deps: DoorPoolDeps)
  start(): void
  postJson(url: string, body: unknown): Promise<{ status: number; json: unknown | null }>
  stats(): DoorStat[]
}
```

Rules:
- Path key = đoạn cuối URL sau dấu `/` cuối cùng (e.g. `https://app.nansen.ai/api/questions/tgm-volume-details` → `tgm-volume-details`).
- `classify` là pure function; `threw: true` → `'transport'` (bất kể status).
- `connect` throw → door `retired` reason `broken-proxy`.
- `DoorConn.fetch` KHÔNG throw vì HTTP status; chỉ set `threw: true` cho timeout/transport.
- `postJson` KHÔNG bao giờ throw; degrade trả `{status: 503, json: null}`.
- Requery tối đa 1 lần thêm (tổng ≤2 `fetch` cho 1 request).
- `start()` fire-and-forget; doors warmup song song.
