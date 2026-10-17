import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TelegramBot, TelegramSendError, formatTelegramAlert, type TelegramAlert, type PeriodicScanReportEntry } from '../src/monitor/telegram.js';

const alert: TelegramAlert = {
  alertId: 'alert-1', chain: 'sol', ca: 'Abc/123&xyz', symbol: '<TOKEN & "x">',
  marketCap: 12345, marketCapAt: 1_700_000_000_000,
  trigger: { metric: 'fresh', previous: 20, current: 26, responseAt: 1_700_000_000_000 },
  nansen: { freshPct: 26, t100Multiple: 2.25, lf: 1250 }, trackedHoldingPct: 3.5, source: 'A',
};

function telegramPayload(init?: RequestInit): Record<string, unknown> {
  if (init?.body instanceof FormData) {
    return Object.fromEntries([...init.body.entries()].map(([key, value]) => [
      key,
      typeof value === 'string' ? value : `[${value.type}:${value.size}]`,
    ]));
  }
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

function telegramText(init?: RequestInit): string {
  const payload = telegramPayload(init);
  return typeof payload.caption === 'string' ? payload.caption : String(payload.text ?? '');
}

test('formats an unlinked dollar ticker, linked GMGN CA, separated sections, and escapes untrusted values', () => {
  const text = formatTelegramAlert(alert);
  assert.doesNotMatch(text.split('\n')[0]!, /^<a\b/);
  assert.match(
    text,
    /^\$&lt;TOKEN &amp; &quot;x&quot;&gt;\nMC: \$12\.35K\n\nCA: <a href="https:\/\/gmgn\.ai\/sol\/token\/Abc%2F123%26xyz">Gmgn<\/a>\n\n<b>👌 Fresh wallet growth: \+30% \(20% → 26%\)<\/b>/,
  );
  assert.equal((text.match(/CA: <a\b/g) ?? []).length, 1);
  assert.match(text, /Nansen: Top100 2\.25 \| Low Float 1\.25K \| Fresh 26%/);
  assert.match(text, /Tracker holding: 3\.5%/);
  assert.match(text, /——/);
  assert.doesNotMatch(text, /Time:|MC at:|Source:|Response:|Alert:|TEST|sample:/);
});

test('includes dashboard Tracked in count, tracked identities and clickable X links', () => {
  const enriched = formatTelegramAlert({
    ...alert,
    source: 'B',
    xHandle: 'hyped_account',
    tracked: {
      count: 8,
      wallets: { names: ['Wallet <A>', 'W&', 'Wallet 3', 'Wallet 4'], total: 4 },
      fomoUsers: { names: ['@fomo_buyer', '@fomo_two', '@fomo_three', '@fomo_four'], total: 4 },
    },
  });
  assert.match(enriched, /\n\nFOMO users: @fomo_buyer, @fomo_two, @fomo_three, @fomo_four/);
  assert.match(enriched, /——\n\nTwitter:/);
  assert.match(enriched, /Twitter: <a href="https:\/\/x\.com\/hyped_account">@hyped_account<\/a>/);
  assert.match(enriched, /href="https:\/\/x\.com\/search\?q=Abc%2F123%26xyz">CA search on X<\/a>/);
});
test('does not duplicate the dollar prefix when a symbol already includes it', () => {
  const text = formatTelegramAlert({ ...alert, symbol: '$STONK' });
  assert.match(text, /^\$STONK\nMC:/);
  assert.doesNotMatch(text.split('\n')[0]!, /\$\$STONK/);
});
test('links the CA to GMGN for every supported alert chain without linking the ticker', () => {
  for (const chain of ['sol', 'base', 'bsc', 'robinhood'] as const) {
    const text = formatTelegramAlert({ ...alert, chain, ca: 'Token/CA' });
    assert.match(text, /^\$&lt;TOKEN &amp; &quot;x&quot;&gt;\n/);
    assert.ok(text.includes(`CA: <a href="https://gmgn.ai/${chain}/token/Token%2FCA">Gmgn</a>`));
  }
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
test('omits event time to match the compact alert layout', () => {
  const text = formatTelegramAlert({
    ...alert,
    trigger: { ...alert.trigger, responseAt: 1_791_508_823_410 },
  });
  assert.doesNotMatch(text, /Time:/);
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
  assert.match(text, /^\$123456…7890\nMC: chưa có/);
  assert.match(text, /CA: <a href="https:\/\/gmgn\.ai\/base\/token\/1234567890">Gmgn<\/a>/);
  assert.match(text, /<b>👌 Top100 increase: 0 → 2<\/b>/);
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
  assert.match(text, /👌 Tracker Buying: &lt;Whale &amp; Co&gt; \(Wallet&lt;1&gt;\) bought \$1,234\.56789/);
});

test('configured requires nonempty token and chat ID', () => {
  assert.equal(new TelegramBot('', 'chat').configured, false);
  assert.equal(new TelegramBot('token', ' ').configured, false);
  assert.equal(new TelegramBot(' token ', 'chat').configured, true);
});

test('uploads Telegram alert caption with HTML and the configured thread', async () => {
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  const bot = new TelegramBot('secret-token', 'chat-42', async (input, init) => {
    requestUrl = String(input);
    requestInit = init;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }, undefined, { alerts: 31 });
  await bot.send(alert);
  assert.equal(requestUrl, 'https://api.telegram.org/botsecret-token/sendPhoto');
  assert.equal(requestInit?.method, 'POST');
  assert.equal(requestInit?.headers, undefined);
  assert.ok(requestInit?.body instanceof FormData);
  const payload = telegramPayload(requestInit);
  assert.equal(payload.chat_id, 'chat-42');
  assert.equal(payload.caption, formatTelegramAlert(alert));
  assert.equal(payload.parse_mode, 'HTML');
  assert.equal(payload.message_thread_id, '31');
  assert.match(String(payload.photo), /^\[image\/jpeg:/);
  assert.ok(requestInit?.signal instanceof AbortSignal);
});

test('uploads a CA avatar with the full alert caption even when the payload has a remote icon URL', async () => {
  const avatarBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const photoAlert: TelegramAlert = {
    ...alert,
    iconUrl: 'https://cdn.dexscreener.com/cms/images/token-icon.png',
  };
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  const bot = new TelegramBot('secret-token', 'chat-42', async (input, init) => {
    requestUrl = String(input);
    requestInit = init;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }, async (_symbol, ca, chain) => {
    assert.equal(ca, photoAlert.ca);
    assert.equal(chain, photoAlert.chain);
    return avatarBytes;
  });
  await bot.send(photoAlert);
  assert.equal(requestUrl, 'https://api.telegram.org/botsecret-token/sendPhoto');
  assert.ok(requestInit?.body instanceof FormData);
  const form = await new Request('http://telegram.test', { method: 'POST', body: requestInit.body }).formData();
  assert.equal(form.get('chat_id'), 'chat-42');
  assert.equal(String(form.get('caption')).replaceAll('\r\n', '\n'), formatTelegramAlert(photoAlert));
  assert.equal(form.get('parse_mode'), 'HTML');
  const photo = form.get('photo');
  assert.ok(photo instanceof File);
  assert.deepEqual(new Uint8Array(await photo.arrayBuffer()), avatarBytes);
});

test('uploads rendered avatar bytes for alerts without a token icon', async () => {
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

test('uses deterministic CA avatar bytes when API avatar loading fails', async () => {
  let method = '';
  const bot = new TelegramBot('token', 'chat', async (input) => {
    method = String(input).split('/').at(-1) ?? '';
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }, async () => {
    throw new Error('avatar API unavailable');
  });

  await bot.send(alert);
  assert.equal(method, 'sendPhoto');
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

test('splits an oversized photo caption without dropping alert details', async () => {
  const payloads: Array<{ method: string; payload: Record<string, unknown> }> = [];
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
  const bot = new TelegramBot('token', 'chat', async (input, init) => {
    payloads.push({ method: String(input).split('/').at(-1) ?? '', payload: telegramPayload(init) });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  await bot.send(longCaption);
  assert.equal(payloads[0]?.method, 'sendPhoto');
  assert.equal(payloads[1]?.method, 'sendMessage');
  assert.equal(payloads[0]?.payload.caption, formatTelegramAlert(longCaption).split(String.fromCharCode(10).repeat(2))[0]);
  assert.match(String(payloads[0]?.payload.photo), /^\[image\/jpeg:/);
  const delivered = payloads.map(({ payload }) => String(payload.caption ?? payload.text ?? ''));
  assert.ok(delivered.every((part) => part.replace(/<[^>]*>/g, '').length <= 4_000));
  assert.equal(delivered.join('').split(longName).length - 1, 6);
  for (const identity of ['B'.repeat(128), 'A'.repeat(128)]) {
    assert.equal(delivered.join('').split(identity).length - 1, 1);
  }
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
    payloads.push(telegramPayload(init));
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
test('delivers every tracked name across bounded Telegram parts', async () => {
  const wallets = Array.from({ length: 40 }, (_, index) =>
    `wallet-${String(index).padStart(3, '0')}-${'w'.repeat(72)}`,
  );
  const fomoUsers = Array.from({ length: 40 }, (_, index) =>
    `fomo-${String(index).padStart(3, '0')}-${'f'.repeat(72)}`,
  );
  const requests: string[] = [];
  const completedParts: number[] = [];
  const completedModes: Array<'photo' | 'text'> = [];
  const bot = new TelegramBot('token', 'chat', async (_input, init) => {
    requests.push(telegramText(init));
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  await bot.send({
    ...alert,
    source: 'B',
    tracked: {
      count: wallets.length + fomoUsers.length,
      wallets: { names: wallets, total: wallets.length },
      fomoUsers: { names: fomoUsers, total: fomoUsers.length },
    },
  }, {
    onPartSent: (sentParts, mode) => {
      completedParts.push(sentParts);
      completedModes.push(mode);
    },
  });

  assert.deepEqual(completedModes, requests.map(() => 'photo'));
  assert.ok(requests.length > 1);
  assert.deepEqual(completedParts, requests.map((_, index) => index + 1));
  for (const request of requests) {
    const visible = request
      .replace(/<[^>]*>/g, '')
      .replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>')
      .replaceAll('&quot;', '"')
      .replaceAll('&amp;', '&');
    assert.ok(visible.length <= 4096);
  }
  for (const name of [...wallets, ...fomoUsers]) {
    assert.equal(requests.filter((request) => request.includes(name)).length, 1);
  }
});
test('sends periodic report header and splits captioned token photos into album batches of ten', async () => {
  let header: Record<string, unknown> | undefined;
  const albums: Array<Array<Record<string, unknown>>> = [];
  const methods: string[] = [];
  const entries: PeriodicScanReportEntry[] = Array.from({ length: 12 }, (_, index) => ({
    source: index < 6 ? 'A' : 'B',
    signal: {
      chain: 'sol',
      ca: `CA${index}`,
      symbol: `TOKEN${index}`,
      iconUrl: `https://cdn.dexscreener.com/cms/images/token-${index}.png`,
      nansen: { lf: 1_000_000 },
      volume24h: 1_000 + index,
      trackedHolding: 0,
    },
  }));
  const bot = new TelegramBot('secret-token', 'chat-42', async (input, init) => {
    const method = String(input).split('/').at(-1) ?? '';
    methods.push(method);
    if (method === 'sendMessage') {
      header = JSON.parse(String(init?.body)) as Record<string, unknown>;
      assert.equal(header.chat_id, 'periodic-chat');
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
    }
    assert.equal(method, 'sendMediaGroup');
    assert.ok(init?.body instanceof FormData);
    const form = init.body;
    assert.equal(form.get('chat_id'), 'periodic-chat');
    assert.equal(form.get('message_thread_id'), null);
    const media = JSON.parse(String(form.get('media'))) as Array<Record<string, unknown>>;
    const firstIndex = albums.reduce((count, album) => count + album.length, 0);
    for (let index = 0; index < media.length; index += 1) {
      assert.ok(form.get(`periodic_avatar_${firstIndex + index}`) instanceof File);
    }
    albums.push(media);
    return new Response(JSON.stringify({
      ok: true, result: media.map((_, index) => ({ message_id: index + 1 })),
    }), { status: 200 });
  }, undefined, {}, 'periodic-chat');

  await bot.sendPeriodicScanReport(entries, '2026-01-02T06:00+07:00', [6]);

  assert.deepEqual(methods, ['sendMessage', 'sendMediaGroup', 'sendMediaGroup']);
  assert.equal(
    header?.text,
    'Periodic scan · Dashboard A+B · 2026-01-02 06:00 UTC+7 · 6h · 12 CA',
  );
  assert.deepEqual(albums.map((album) => album.length), [10, 2]);
  assert.match(String(albums[0]![0]!.caption), /^Dashboard A · 2026-01-02 06:00 UTC\+7/);
  assert.match(String(albums[1]![1]!.caption), /^Dashboard B · 2026-01-02 06:00 UTC\+7/);
  assert.ok(String(albums[1]![1]!.caption).includes('CA: <a href="https://gmgn.ai/sol/token/CA11">Gmgn</a>'));
});
test('sends a single periodic entry as a CA-avatar photo after the outer header', async () => {
  const methods: string[] = [];
  let photoPayload: FormData | undefined;
  const bot = new TelegramBot('token', 'chat', async (input, init) => {
    const method = String(input).split('/').at(-1) ?? '';
    methods.push(method);
    if (method === 'sendPhoto') {
      assert.ok(init?.body instanceof FormData);
      photoPayload = init.body;
    }
    return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
  }, undefined, {}, 'periodic-chat');
  await bot.sendPeriodicScanReport([{
    source: 'B',
    signal: {
      chain: 'sol', ca: 'CA1', symbol: 'DEMO', iconUrl: 'https://cdn.dexscreener.com/cms/images/demo.png',
      nansen: {}, volume24h: 1, trackedHolding: 0,
    },
  }], '2026-01-02T06:00+07:00', [6]);
  assert.deepEqual(methods, ['sendMessage', 'sendPhoto']);
  assert.equal(photoPayload?.get('chat_id'), 'periodic-chat');
  assert.equal(photoPayload?.get('message_thread_id'), null);
  assert.ok(String(photoPayload?.get('caption')).startsWith('Dashboard B · 2026-01-02 06:00 UTC+7'));
  assert.ok(photoPayload?.get('periodic_avatar_0') instanceof File);
});
test('never falls back to the live-alert channel when the periodic channel is missing', async () => {
  let requests = 0;
  const bot = new TelegramBot('token', 'live-alert-chat', async () => {
    requests += 1;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });

  await assert.rejects(bot.sendPeriodicScanReport([{
    source: 'A',
    signal: {
      chain: 'sol', ca: 'CA1', symbol: 'DEMO', iconUrl: 'https://cdn.example.com/token.png',
      nansen: {}, volume24h: 1, trackedHolding: 0,
    },
  }], '2026-01-02T06:00+07:00', [6]), /Periodic scan Telegram channel is not configured/);
  assert.equal(requests, 0);
});
