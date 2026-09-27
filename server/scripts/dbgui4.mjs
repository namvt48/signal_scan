// Read the chart's timeframe ToggleButtonGroup for tokens of many ages and print
// each button's label + disabled state -> derives the exact "highest enabled TF" rule.
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

const WS = process.env.CRAWL_WS_ENDPOINT || 'ws://localhost:3000';
const CAS = JSON.parse(fs.readFileSync('/tmp/opencode/cas20.json', 'utf8'));
const now = Date.now();

const browser = await puppeteer.connect({ browserWSEndpoint: WS, defaultViewport: { width: 1440, height: 1000 } });
const page = await browser.newPage();
await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
await page.evaluateOnNewDocument(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });

const read = () => page.evaluate(() => {
  const btns = [...document.querySelectorAll('button,[role="button"]')].filter((n) => /MuiToggleButton/.test(n.className || ''));
  const groups = new Map();
  for (const b of btns) {
    const key = (b.parentElement?.className || '').toString().slice(0, 40);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ text: (b.textContent || '').trim(), disabled: !!b.disabled, selected: b.getAttribute('aria-pressed') || b.className.includes('Mui-selected') });
  }
  const body = document.body.innerText.replace(/\s+/g, ' ');
  return { groups: [...groups.entries()].map(([k, v]) => ({ k, v })), symbol: (body.match(/Token God Mode Holders PnL Leaderboard[^]{0,80}/) || [''])[0].slice(-80) };
});

const rows = [];
for (const c of CAS) {
  const ageD = ((now - c.d) / 864e5).toFixed(2);
  const url = `https://app.nansen.ai/token-god-mode?tokenAddress=${c.ca}&chain=solana`;
  let out = { sym: c.sym, ageD, groups: null, err: null };
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40_000 });
    await new Promise((r) => setTimeout(r, 5200));
    const info = await read();
    // pick the group that looks like a timeframe selector (contains D/1h/Max labels)
    const tf = info.groups.find((g) => g.v.some((b) => /^(1h|1D|7D|30D|1M|3M|90D|1Y|Max|All)$/i.test(b.text)));
    out.groups = tf ? tf.v : info.groups;
    out.symbol = info.symbol;
  } catch (e) { out.err = String(e).slice(0, 70); }
  rows.push(out);
  const fmt = (out.groups || []).map((b) => `${b.text}${b.disabled ? '(x)' : ''}${b.selected ? '*' : ''}`).join(' ');
  console.log(`${out.sym.padEnd(10)} age=${ageD.padStart(6)}d  ${out.err ? `ERR ${out.err}` : fmt}`);
  await new Promise((r) => setTimeout(r, 900));
}
fs.writeFileSync('/tmp/opencode/tf-buttons.json', JSON.stringify(rows, null, 1));
console.log('\n(x)=disabled  *=selected');
await page.close().catch(() => {});
process.stdout.write('', () => process.exit(0));
