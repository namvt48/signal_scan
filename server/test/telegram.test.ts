import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TelegramBot, TelegramSendError, formatTelegramAlert, type TelegramAlert } from '../src/monitor/telegram.js';

const alert: TelegramAlert = {
  alertId: 'alert-1', chain: 'sol', ca: 'Abc/123&xyz', symbol: '<TOKEN & "x">',
  marketCap: 12345, marketCapAt: 1_700_000_000_000,
  trigger: { metric: 'fresh', previous: 20, current: 26, responseAt: 1_700_000_000_000 },
  nansen: { freshPct: 26, t100Multiple: 2.25, lf: 1250 }, trackedHoldingPct: 3.5, source: 'A',
};

test('formats linked ticker, metric delta, factors and escapes untrusted values', () => {
  const text = formatTelegramAlert(alert);
  assert.match(text, /href="https:\/\/gmgn\.ai\/sol\/token\/Abc%2F123%26xyz"/);
  assert.match(text, />&lt;TOKEN &amp; &quot;x&quot;&gt;<\/a>/);
  assert.match(text, /MC: \$12\.35K/);
  assert.match(text, /<b>Fresh wallet growth: \+30% \(20% → 26%\)<\/b>/);
  assert.match(text, /Nansen: Top100 2\.25 \| Low Float 1\.25K \| Fresh 26%/);
  assert.match(text, /Tracker holding: 3\.5%/);
  assert.equal(text.split(/\r?\n/).length, 7);
  assert.doesNotMatch(text, /MC at:|Source:|Response:|Alert:|TEST|sample:/);
});

test('includes dashboard Tracked in count, tracked identities and clickable X links', () => {
  const enriched = formatTelegramAlert({
    ...alert,
    source: 'B',
    xHandle: 'hyped_account',
    tracked: {
      count: 4,
      wallets: { names: ['Wallet <A>', 'W&'], total: 3 },
      fomoUsers: { names: ['@fomo_buyer'], total: 1 },
    },
  });
  assert.match(enriched, /Tracked in: 4/);
  assert.match(enriched, /Tracked by: Wallet &lt;A&gt;, W&amp; \+1 more/);
  assert.match(enriched, /FOMO users: @fomo_buyer/);
  assert.match(enriched, /Twitter: <a href="https:\/\/x\.com\/hyped_account">@hyped_account<\/a>/);
  assert.match(enriched, /href="https:\/\/x\.com\/search\?q=Abc%2F123%26xyz">CA search on X<\/a>/);
});
test('formats market cap in compact USD at K, M and B thresholds', () => {
  const cases: Array<[number, string]> = [
    [0, '$0'],
    [999, '$999'],
    [1_000, '$1K'],
    [12_345, '$12.35K'],
    [999_999, '$1M'],
    [1_000_000, '$1M'],
    [1_250_000, '$1.25M'],
    [1_000_000_000, '$1B'],
    [2_500_000_000, '$2.5B'],
    [-1_250, '-$1.25K'],
  ];
  for (const [marketCap, expected] of cases) {
    const text = formatTelegramAlert({ ...alert, marketCap });
    assert.equal(text.split(/\r?\n/)[1], `MC: ${expected}`);
  }
});
test('formats one final trigger time as UTC+7 without milliseconds or offset text', () => {
  const text = formatTelegramAlert({
    ...alert,
    trigger: { ...alert.trigger, responseAt: 1_791_508_823_410 },
  });
  assert.equal(text.split(/\r?\n/).at(-1), 'Time: 2026-10-09 08:20:23');
  assert.equal(text.split(/\r?\n/).filter((line) => line.startsWith('Time:')).length, 1);
});

test('formats tiny tracker holdings with dashboard percentage precision', () => {
  const text = formatTelegramAlert({ ...alert, trackedHoldingPct: 1e-13 });
  assert.match(text, /Tracker holding: 0%/);
});


test('formats absent optional values as chưa có and falls back to shortened CA', () => {
  const missing: TelegramAlert = {
    alertId: 'missing', chain: 'base', ca: '1234567890',
    trigger: { metric: 't100', previous: 0, current: 2, responseAt: 0 },
    nansen: {}, source: 'B',
  };
  const text = formatTelegramAlert(missing);
  assert.match(text, />123456…7890<\/a>/);
  assert.match(text, /MC: chưa có/);
  assert.match(text, /<b>Top100 increase: 0 → 2<\/b>/);
  assert.match(text, /Nansen: Top100 chưa có \| Low Float chưa có \| Fresh chưa có/);
  assert.match(text, /Tracker holding: chưa có/);
  assert.doesNotMatch(text, /undefined|null/);
});
test('formats Tracker Buying with wallet identity and the USD amount, escaping wallet-provided text', () => {
  const trackerBuy: TelegramAlert = {
    ...alert,
    trigger: {
      metric: 'trackerBuy',
      previous: 0,
      current: 1_234.56789,
      responseAt: 1_700_000_000_000,
      buyer: { name: '<Whale & Co>', address: 'Wallet<1>' },
    },
  };
  const text = formatTelegramAlert(trackerBuy);
  assert.match(text, /Tracker Buying: &lt;Whale &amp; Co&gt; \(Wallet&lt;1&gt;\) bought \$1,234\.56789/);
});

test('configured requires nonempty token and chat ID', () => {
  assert.equal(new TelegramBot('', 'chat').configured, false);
  assert.equal(new TelegramBot('token', ' ').configured, false);
  assert.equal(new TelegramBot(' token ', 'chat').configured, true);
});

test('posts HTML sendMessage payload with link previews disabled', async () => {
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  const bot = new TelegramBot('secret-token', 'chat-42', async (input, init) => {
    requestUrl = String(input);
    requestInit = init;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  await bot.send(alert);
  assert.equal(requestUrl, 'https://api.telegram.org/botsecret-token/sendMessage');
  assert.equal(requestInit?.method, 'POST');
  assert.equal((requestInit?.headers as Record<string, string>)['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(String(requestInit?.body)), {
    chat_id: 'chat-42', text: formatTelegramAlert(alert), parse_mode: 'HTML', disable_web_page_preview: true,
  });
  assert.ok(requestInit?.signal instanceof AbortSignal);
});

test('posts a validated token avatar with the full alert caption', async () => {
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  const photoAlert: TelegramAlert = {
    ...alert,
    iconUrl: 'https://cdn.dexscreener.com/cms/images/token-icon.png',
    xHandle: 'hyped_account',
    tracked: {
      count: 2,
      wallets: { names: ['Native Whale'], total: 1 },
      fomoUsers: { names: ['@fomo_buyer'], total: 1 },
    },
    source: 'B',
  };
  const bot = new TelegramBot('secret-token', 'chat-42', async (input, init) => {
    requestUrl = String(input);
    requestInit = init;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  await bot.send(photoAlert);
  assert.equal(requestUrl, 'https://api.telegram.org/botsecret-token/sendPhoto');
  assert.deepEqual(JSON.parse(String(requestInit?.body)), {
    chat_id: 'chat-42',
    photo: photoAlert.iconUrl,
    caption: formatTelegramAlert(photoAlert),
    parse_mode: 'HTML',
  });
});

test('sends a dashboard-style letter avatar for alerts without a token icon', async () => {
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  const avatarBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const bot = new TelegramBot('secret-token', 'chat-42', async (input, init) => {
    requestUrl = String(input);
    requestInit = init;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }, async (symbol) => {
    assert.equal(symbol, alert.symbol);
    return avatarBytes;
  });

  await bot.send(alert);

  assert.equal(requestUrl, 'https://api.telegram.org/botsecret-token/sendPhoto');
  assert.equal(requestInit?.headers, undefined);
  assert.ok(requestInit?.body instanceof FormData);
  const form = await new Request('http://telegram.test', { method: 'POST', body: requestInit.body }).formData();
  assert.equal(form.get('chat_id'), 'chat-42');
  assert.equal(String(form.get('caption')).replaceAll('\r\n', '\n'), formatTelegramAlert(alert));
  assert.equal(form.get('parse_mode'), 'HTML');
  const photo = form.get('photo');
  assert.ok(photo instanceof File);
  assert.equal(photo.name, 'token-avatar.jpg');
  assert.deepEqual(new Uint8Array(await photo.arrayBuffer()), avatarBytes);
});

test('falls back to text when optional avatar rendering fails before sending', async () => {
  let method = '';
  const bot = new TelegramBot('token', 'chat', async (input) => {
    method = String(input).split('/').at(-1) ?? '';
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }, async () => {
    throw new Error('renderer unavailable');
  });

  await bot.send(alert);

  assert.equal(method, 'sendMessage');
});

test('falls back to text when Telegram explicitly rejects a generated avatar photo', async () => {
  const methods: string[] = [];
  const bot = new TelegramBot('token', 'chat', async (input) => {
    methods.push(String(input).split('/').at(-1) ?? '');
    return methods.length === 1
      ? new Response(JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: photo rejected' }), { status: 400 })
      : new Response(JSON.stringify({ ok: true }), { status: 200 });
  }, async () => new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));

  await bot.send(alert);

  assert.deepEqual(methods, ['sendPhoto', 'sendMessage']);
});

test('uses sendMessage when a photo caption exceeds Telegram caption limits', async () => {
  const methods: string[] = [];
  const longName = 'N'.repeat(128);
  const longCaption: TelegramAlert = {
    ...alert,
    iconUrl: 'https://cdn.dexscreener.com/cms/images/token-icon.png',
    trigger: {
      metric: 'trackerBuy',
      previous: 0,
      current: 100_000,
      responseAt: alert.trigger.responseAt,
      buyer: { name: 'B'.repeat(128), address: 'A'.repeat(128) },
    },
    source: 'B',
    tracked: {
      count: 6,
      wallets: { names: [longName, longName, longName], total: 3 },
      fomoUsers: { names: [longName, longName, longName], total: 3 },
    },
  };
  const bot = new TelegramBot('token', 'chat', async (input) => {
    methods.push(String(input).split('/').at(-1) ?? '');
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  await bot.send(longCaption);
  assert.deepEqual(methods, ['sendMessage']);
});

test('falls back to text only after Telegram explicitly rejects the photo request', async () => {
  const methods: string[] = [];
  const payloads: Array<Record<string, unknown>> = [];
  const photoAlert: TelegramAlert = {
    ...alert,
    iconUrl: 'https://cdn.dexscreener.com/cms/images/token-icon.png',
  };
  const bot = new TelegramBot('token', 'chat', async (input, init) => {
    methods.push(String(input).split('/').at(-1) ?? '');
    payloads.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    if (methods.length === 1) {
      return new Response(JSON.stringify({
        ok: false,
        error_code: 400,
        description: 'Bad Request: failed to get HTTP URL content',
      }), { status: 400 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  await bot.send(photoAlert);
  assert.deepEqual(methods, ['sendPhoto', 'sendMessage']);
  assert.equal(payloads[1]?.text, formatTelegramAlert(photoAlert));
});

test('does not retry a photo after an ambiguous network failure', async () => {
  let requests = 0;
  const photoAlert: TelegramAlert = {
    ...alert,
    iconUrl: 'https://cdn.dexscreener.com/cms/images/token-icon.png',
  };
  const bot = new TelegramBot('token', 'chat', async () => {
    requests += 1;
    throw new Error('connection reset');
  });
  await assert.rejects(bot.send(photoAlert), /Telegram request failed/);
  assert.equal(requests, 1);
});

test('does not fall back to text when a photo response is an ambiguous HTTP 5xx', async () => {
  let requests = 0;
  const photoAlert: TelegramAlert = {
    ...alert,
    iconUrl: 'https://cdn.dexscreener.com/cms/images/token-icon.png',
  };
  const bot = new TelegramBot('token', 'chat', async () => {
    requests += 1;
    return requests === 1
      ? new Response(JSON.stringify({
        ok: false, error_code: 400, description: 'Bad Request: photo rejected',
      }), { status: 500 })
      : new Response(JSON.stringify({ ok: true }), { status: 200 });
  });

  await assert.rejects(bot.send(photoAlert), (error: unknown) => {
    assert.ok(error instanceof TelegramSendError);
    assert.equal(error.deliveryStatus, 'unknown');
    return true;
  });
  assert.equal(requests, 1);
});

test('does not fall back to text for an unparseable HTTP 400 photo response', async () => {
  let requests = 0;
  const photoAlert: TelegramAlert = {
    ...alert,
    iconUrl: 'https://cdn.dexscreener.com/cms/images/token-icon.png',
  };
  const bot = new TelegramBot('token', 'chat', async () => {
    requests += 1;
    return requests === 1
      ? new Response('not JSON', { status: 400 })
      : new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  await assert.rejects(bot.send(photoAlert), /Telegram returned invalid JSON \(HTTP 400\)/);
  assert.equal(requests, 1);
});

test('surfaces Telegram ok:false and retry_after in milliseconds', async () => {
  const bot = new TelegramBot('token', 'chat', async () => new Response(JSON.stringify({
    ok: false, description: 'Too Many Requests', parameters: { retry_after: 7 },
  }), { status: 429 }));
  await assert.rejects(bot.send(alert), (error: unknown) => {
    assert.ok(error instanceof TelegramSendError);
    assert.equal(error.message, 'Too Many Requests');
    assert.equal(error.retryDelayMs, 7_000);
    assert.equal(error.deliveryStatus, 'rejected');
    assert.equal(error.retryable, true);
    return true;
  });
});

test('treats Telegram 5xx as an ambiguous delivery result', async () => {
  const bot = new TelegramBot('token', 'chat', async () => new Response(JSON.stringify({
    ok: false, description: 'Internal server error',
  }), { status: 500 }));
  await assert.rejects(bot.send(alert), (error: unknown) => {
    assert.ok(error instanceof TelegramSendError);
    assert.equal(error.deliveryStatus, 'unknown');
    assert.equal(error.retryable, false);
    return true;
  });
});

test('rejects unsuccessful HTTP response even if Telegram reports ok', async () => {
  const bot = new TelegramBot('token', 'chat', async () =>
    new Response(JSON.stringify({ ok: true }), { status: 500 }));
  await assert.rejects(bot.send(alert), /Telegram send failed \(HTTP 500\)/);
});
