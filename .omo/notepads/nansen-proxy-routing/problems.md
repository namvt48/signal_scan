# Problems — nansen-proxy-routing

Unresolved blockers. APPEND ONLY.

## Owner-gated (không chặn worker)
- Live QA với proxy thật: chưa có ./data/proxies.txt thật + credential → smoke với proxy thật CHỜ owner. Fallback trong repo: --simulate (fake transport) + docker local chrome + proxy hỏng cố ý.
- OQ1: RAM trống server prod → chặn N doors tối đa (công thức D9).
- OQ2: cadence — đã adopt repair (D12); giữ cadence prod cần ≥6 dedicated IP.
- Owner action: rotate NANSEN_API_KEY (đã lộ trong evidence) — ngoài scope plan.
