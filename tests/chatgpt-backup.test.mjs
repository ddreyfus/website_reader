import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
import { chromium } from 'playwright';

const source = await fs.readFile(new URL('../chatgpt-backup.js', import.meta.url), 'utf8');
const events = { addListener() {} };
function inventoryContext(read) {
  const commits = [], progress = [];
  const context = vm.createContext({ URL, AbortSignal, chrome: { tabs: { onUpdated: events }, alarms: { onAlarm: events } } });
  vm.runInContext(source, context);
  context.chatGPTReadPage = read;
  context.chatGPTBackupActive = async () => true;
  context.chatGPTBackupCounts = async () => {};
  context.chatGPTBackupProgress = async text => progress.push(text);
  context.chatGPTArchive = async (action, body) => { if (action === 'discover') commits.push(JSON.parse(JSON.stringify(body))); return {}; };
  return { context, commits, progress };
}
const entry = (id, time) => ({ id, title: id, update_time: time });

test('inventory establishes a full baseline before stopping on old update-ordered pages', async () => {
  const calls = [];
  let incremental = false;
  const now = Date.now();
  const { context, commits } = inventoryContext(async (tab, identity, kind, id, cursor) => {
    calls.push([kind, id, cursor]);
    if (kind === 'identity') return { identity: 'user:personal' };
    if (kind === 'projects') return { data: { items: [{ gizmo: { gizmo: { id: 'g-p-project', display: { name: 'Project' } } } }], cursor: null } };
    if (id === 'g-p-project') return { data: { items: [], cursor: null } };
    if (id === 'archived') return { data: { items: [], offset: 0, total: 0 } };
    const items = incremental ? [entry('new', (now + 1000) / 1000), entry('old', (now - 300000) / 1000)]
      : cursor === '' ? [entry('latest', now / 1000)] : [entry('old', (now - 300000) / 1000)];
    return { data: { items, offset: Number(cursor), total: incremental ? 100 : 2 } };
  });
  assert.equal(await context.chatGPTInventory(20, 'scope', null), true);
  let checkpoint = commits.at(-1).checkpoint;
  assert.equal(checkpoint.complete, true);
  assert.equal(checkpoint.lists.find(x => x.id === 'recent').baseline, true);
  assert.ok(calls.some(x => x[1] === 'recent' && x[2] === '1'));
  // Even an old baseline (or a legacy forced-full flag) must stay incremental.
  checkpoint.fullAt = now - 2 * 86400000;
  checkpoint.full = true;
  incremental = true; calls.length = 0;
  assert.equal(await context.chatGPTInventory(20, 'scope', checkpoint), true);
  assert.equal(calls.filter(x => x[1] === 'recent').length, 1);
  assert.ok(calls.filter(x => x[1] === 'recent').every(x => x[2] === ''));
  assert.ok(commits.at(-1).checkpoint.completedAt);
});

test('inventory refreshes unknown projects once, persists names, and drops legacy project scans', async () => {
  const calls = [];
  const { context, commits } = inventoryContext(async (tab, identity, kind, id, cursor) => {
    calls.push([kind, id, cursor]);
    if (kind === 'identity') return { identity: 'user:personal' };
    if (kind === 'projects') return { data: cursor === ''
      ? { items: [{ gizmo: { gizmo: { id: 'g-p-known', display: { name: 'Known' } } } }], cursor: 'next' }
      : { items: [{ gizmo: { gizmo: { id: 'g-p-new', display: { name: 'New' } } } }], cursor: null } };
    return { data: { items: id === 'recent' ? [
      { ...entry('chat', 100), gizmo_id: 'g-p-new' },
      { ...entry('missing', 99), gizmo_id: 'g-p-missing' }
    ] : [], offset: 0, total: id === 'recent' ? 2 : 0 } };
  });
  const checkpoint = { identity: 'user:personal', complete: false, lists: [
    { id: 'recent', title: 'recent', cursor: '', done: false },
    { id: 'archived', title: 'archived', cursor: '', done: false },
    { id: 'g-p-legacy', title: 'Legacy', cursor: 'old', done: false }
  ] };
  const projects = { 'g-p-known': 'Known', 'g-p-new': '' };
  assert.equal(await context.chatGPTInventory(20, 'scope', checkpoint, projects), true);
  assert.equal(calls.filter(x => x[0] === 'projects').length, 2);
  assert.ok(!calls.some(x => x[1] === 'g-p-legacy'));
  assert.equal(commits.find(x => x.projects?.['g-p-new']).projects['g-p-new'], 'New');
  assert.equal(commits.flatMap(x => x.conversations).find(x => x.id === 'chat').project_title, 'New');
  calls.length = 0;
  // Once all referenced IDs are known, the next sync needs no project listing.
  projects['g-p-missing'] = 'Missing';
  assert.equal(await context.chatGPTInventory(20, 'scope', commits.at(-1).checkpoint, projects), true);
  assert.ok(!calls.some(x => x[0] === 'projects'));
});

test('project metadata refresh resumes after interruption before committing its conversation page', async () => {
  let interrupted = true;
  const calls = [];
  const { context, commits } = inventoryContext(async (tab, identity, kind, id, cursor) => {
    calls.push([kind, id, cursor]);
    if (kind === 'identity') return { identity: 'user:personal' };
    if (kind === 'projects') {
      if (cursor === 'next' && interrupted) throw new Error('interrupted');
      return { data: cursor === '' ? { items: [{ gizmo: { gizmo: { id: 'g-p-other', display: { name: 'Other' } } } }], cursor: 'next' } : {
        items: [{ gizmo: { gizmo: { id: 'g-p-new', display: { name: 'New' } } } }], cursor: null
      } };
    }
    return { data: { items: id === 'recent' ? [{ ...entry('chat', 100), gizmo_id: 'g-p-new' }] : [], offset: 0, total: id === 'recent' ? 1 : 0 } };
  });
  await assert.rejects(context.chatGPTInventory(20, 'scope', null), /interrupted/);
  const saved = commits.at(-1);
  assert.equal(saved.checkpoint.lists.find(x => x.id === 'projects').cursor, 'next');
  assert.ok(!commits.some(x => x.conversations.length));
  interrupted = false; calls.length = 0;
  assert.equal(await context.chatGPTInventory(20, 'scope', saved.checkpoint, saved.projects), true);
  assert.deepEqual(calls.filter(x => x[0] === 'projects'), [['projects', 'projects', 'next']]);
  assert.equal(commits.flatMap(x => x.conversations).find(x => x.id === 'chat').project_title, 'New');
});

test('inventory preserves its scan-start cutoff across retries and includes boundary timestamps', async () => {
  const startedAt = 1000000;
  let fail = true;
  const calls = [];
  const { context, commits } = inventoryContext(async (tab, identity, kind, id, cursor) => {
    if (kind === 'identity') return { identity: 'user:personal' };
    calls.push(cursor);
    if (cursor === '2' && fail) throw new Error('interrupted');
    const items = cursor === ''
      ? [entry('changed-during-scan', 1100), entry('equal-boundary', 880)]
      : [entry('older', 879)];
    return { data: { items, total: 100, offset: Number(cursor) } };
  });
  const checkpoint = { identity: 'user:personal', complete: true, lists: [
    { id: 'recent', title: 'Recent', done: true, baseline: true, orderVerified: true, watermark: startedAt }
  ] };
  context.Date = class extends Date { static now() { return startedAt; } };
  await assert.rejects(context.chatGPTInventory(20, 'scope', checkpoint), /interrupted/);
  const resumed = commits.at(-1).checkpoint;
  assert.equal(resumed.startedAt, startedAt);
  assert.equal(resumed.lists[0].watermark, startedAt);
  fail = false;
  context.Date = class extends Date { static now() { return startedAt + 500000; } };
  assert.equal(await context.chatGPTInventory(20, 'scope', resumed), true);
  assert.deepEqual(calls, ['', '2', '2']);
  assert.equal(commits.at(-1).checkpoint.lists[0].watermark, startedAt);
});

test('interrupted inventory resumes its committed cursor and unordered pages disable early stopping', async () => {
  let fail = true;
  const calls = [];
  const { context, commits } = inventoryContext(async (tab, identity, kind, id, cursor) => {
    if (kind === 'identity') return { identity: 'user:personal' };
    calls.push(cursor);
    if (cursor === '1' && fail) throw new Error('network interrupted');
    return { data: { items: [entry(cursor || 'first', cursor === '1' ? 20 : 10)], total: 2, offset: Number(cursor) } };
  });
  const checkpoint = { identity: 'user:personal', complete: true, completedAt: Date.now(), fullAt: Date.now(), lists: [{ id: 'recent', title: 'Recent', baseline: true, orderVerified: true, watermark: 1, cursor: '', done: true }] };
  await assert.rejects(context.chatGPTInventory(20, 'scope', checkpoint), /network interrupted/);
  const resumed = commits.at(-1).checkpoint;
  assert.equal(resumed.complete, false);
  assert.equal(resumed.lists[0].cursor, '1');
  fail = false; calls.length = 0;
  assert.equal(await context.chatGPTInventory(20, 'scope', resumed), true);
  assert.deepEqual(calls, ['1']); // Resume without re-reading the first page.
  assert.equal(commits.at(-1).checkpoint.lists[0].orderVerified, false);
});

test('structured adapter keeps credentials page-local and respects access/rate failures', async () => {
  const calls = [];
  const context = vm.createContext({
    URL, AbortSignal, location: { origin: 'https://chatgpt.com' }, document: { cookie: '' },
    chrome: { tabs: { onUpdated: events }, alarms: { onAlarm: events } },
    async fetch(path, options) {
      calls.push([path, options]);
      return { ok: true, async json() { return path === '/api/auth/session' ? { accessToken: 'private-token', user: { id: 'user' } } : { messages: [], page_info: {} }; } };
    }
  });
  vm.runInContext(source, context);
  const result = await context.chatGPTRead('conversation', 'chat', 'older');
  assert.equal(result.identity, 'user:personal');
  assert.deepEqual(JSON.parse(JSON.stringify(result.requests)), [['authentication', 200], ['download', 200]]);
  assert.equal(calls[1][1].headers.Authorization, 'Bearer private-token');
  assert.match(calls[1][0], /messages\?before=older/);
  assert.doesNotMatch(JSON.stringify(result), /private-token/);
  context.document.cookie = '_account=default';
  let account = { structure: 'personal', account_id: null };
  context.fetch = async path => ({ ok: true, async json() { return path === '/api/auth/session' ? { accessToken: 'private-token', user: { id: 'user' } } : path.includes('/accounts/check/') ? { accounts: { default: { account } } } : {}; } });
  assert.equal((await context.chatGPTRead('identity')).identity, 'user:default');
  context.document.cookie = '_account=personal';
  assert.equal((await context.chatGPTRead('identity')).identity, 'user:personal');
  context.document.cookie = '_account=default';
  delete context[Symbol.for('website-reader.chatgpt-backup.session')];
  account = { structure: 'workspace', account_id: null };
  assert.match((await context.chatGPTRead('identity')).error, /matching entry: true; type: workspace/);
  account = { structure: 'workspace', account_id: 'team' };
  assert.equal((await context.chatGPTRead('identity')).identity, 'user:default');
  context.document.cookie = '_account=%22team%22';
  assert.equal((await context.chatGPTRead('identity')).identity, 'user:team');
  context.document.cookie = '_account=missing';
  assert.match((await context.chatGPTRead('identity')).error, /matching entry: false/);
  delete context[Symbol.for('website-reader.chatgpt-backup.session')];
  context.fetch = async () => ({ ok: false, status: 429, headers: { get: () => '120' } });
  const limited = await context.chatGPTRead('identity');
  assert.equal(limited.status, 429);
  assert.deepEqual(JSON.parse(JSON.stringify(limited.requests)), [['authentication', 429]]);
  assert.equal(limited.retrySeconds, 120);
  assert.doesNotMatch(JSON.stringify(limited), /private-token/);
});

test('page-local authentication is reused across pages and refreshed after expiry or access rejection', async () => {
  const calls = [];
  let reject = false, now = Date.now();
  const context = vm.createContext({
    URL, AbortSignal, Date: class extends Date { static now() { return now; } },
    location: { origin: 'https://chatgpt.com' }, document: { cookie: '_account=team' },
    chrome: { tabs: { onUpdated: events }, alarms: { onAlarm: events } },
    async fetch(path, options) {
      calls.push([path, options.headers]);
      if (path === '/api/auth/session') return { ok: true, async json() { return { accessToken: 'private-token', user: { id: 'user' } }; } };
      if (path.includes('/accounts/check/')) return { ok: true, async json() { return { accounts: { team: { account: { account_id: 'team', structure: 'workspace' } } } }; } };
      if (reject) { reject = false; return { ok: false, status: 401, headers: { get() { return null; } } }; }
      return { ok: true, async json() { return {}; } };
    }
  });
  vm.runInContext(source, context);
  await context.chatGPTRead('identity');
  const first = await context.chatGPTRead('list', 'recent', '0');
  await context.chatGPTRead('list', 'recent', '50');
  await context.chatGPTRead('conversation', 'chat', '', 'g-p-project');
  await context.chatGPTRead('list', 'archived');
  assert.equal(calls.filter(([path]) => path === '/api/auth/session').length, 1);
  assert.equal(calls.filter(([path]) => path.includes('/accounts/check/')).length, 1);
  assert.equal(calls.at(-1)[1]['Chatgpt-Account-Id'], 'team');
  assert.equal(calls.at(-1)[1]['Chatgpt-Project-Id'], undefined);
  assert.doesNotMatch(JSON.stringify(first), /private-token/);
  now += 300001;
  await context.chatGPTRead('list', 'recent');
  assert.equal(calls.filter(([path]) => path === '/api/auth/session').length, 2);
  reject = true;
  assert.equal((await context.chatGPTRead('list', 'recent')).status, 401);
  await context.chatGPTRead('list', 'recent');
  assert.equal(calls.filter(([path]) => path === '/api/auth/session').length, 3);
  context.document.cookie = '';
  assert.equal((await context.chatGPTRead('identity')).identity, 'user:personal');
  assert.equal(calls.filter(([path]) => path === '/api/auth/session').length, 4);
});

test('HTTP diagnostics retain request context and safe error fields with bounded body reads', async () => {
  let response;
  const context = vm.createContext({
    URL, AbortSignal, TextDecoder, location: { origin: 'https://chatgpt.com' }, document: { cookie: '' },
    chrome: { tabs: { onUpdated: events }, alarms: { onAlarm: events } },
    async fetch(path) {
      return path === '/api/auth/session'
        ? { ok: true, async json() { return { accessToken: 'private-token', user: { id: 'user' } }; } }
        : response;
    }
  });
  vm.runInContext(source, context);
  response = new Response(JSON.stringify({
    error: { code: 'rate_limit_exceeded', type: 'throttle', message: 'Wait. Bearer private-token access_token=secret person@example.com' },
    accessToken: 'session-secret', messages: [{ content: 'private conversation text' }]
  }), { status: 429, headers: { 'Retry-After': '120', 'Content-Type': 'application/json', 'x-request-id': 'req-123', 'cf-ray': 'ray-456', 'Set-Cookie': 'secret-cookie' } });
  const result = await context.chatGPTRead('list', 'recent', '50');
  assert.equal(result.status, 429);
  assert.deepEqual(JSON.parse(JSON.stringify(result.requests)), [['authentication', 200], ['inventory', 429]]);
  assert.equal(result.retrySeconds, 120);
  assert.match(result.error, /Endpoint: \/backend-api\/conversations; list=recent; offset=50/);
  assert.match(result.error, /x-request-id=req-123/);
  assert.match(result.error, /cf-ray=ray-456/);
  assert.match(result.error, /rate_limit_exceeded; throttle/);
  assert.doesNotMatch(JSON.stringify(result), /private-token|session-secret|secret-cookie|=secret|person@example|private conversation/);
  let cancelled = false;
  response = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('<html>' + 'private content'.repeat(1000))); },
    cancel() { cancelled = true; }
  }), { status: 429 });
  const html = await context.chatGPTRead('list', 'archived');
  assert.ok(cancelled);
  assert.match(html.error, /body omitted/);
  assert.doesNotMatch(html.error, /private content/);
  assert.ok(html.error.length < 1024);
  response = new Response('{}', { status: 503, headers: { 'Retry-After': new Date(Date.now() + 180000).toUTCString() } });
  const dated = await context.chatGPTRead('list', 'recent');
  assert.ok(dated.retrySeconds >= 179 && dated.retrySeconds <= 180);
});

test('pacing spaces actual requests, counts loading time, and includes authentication', async () => {
  let now = 10000;
  const starts = [], waits = [];
  const context = vm.createContext({ URL, AbortSignal,
    Date: class extends Date { static now() { return now; } },
    setTimeout(fn, ms) { waits.push(ms); now += ms; fn(); },
    location: { origin: 'https://chatgpt.com' }, document: { cookie: '_account=default' },
    chrome: { tabs: { onUpdated: events }, alarms: { onAlarm: events } },
    async fetch(path) {
      starts.push(now); now += path === '/api/auth/session' ? 3000 : 500;
      return { ok: true, async json() { return path === '/api/auth/session'
        ? { accessToken: 'token', user: { id: 'user' } }
        : path.includes('/accounts/check/') ? { accounts: { default: { account: { structure: 'personal' } } } } : { items: [] }; } };
    }
  });
  vm.runInContext(source, context);
  const first = await context.chatGPTRead('list', 'recent', '', '', 2000, 9000);
  assert.deepEqual(starts, [11000, 14000, 16000]);
  assert.deepEqual(waits, [1000, 1500]); // The slow first response already exceeds the interval.
  assert.equal(first.lastRequestAt, 16000);
  const second = await context.chatGPTRead('conversation', 'chat', '', '', 2000, first.lastRequestAt);
  assert.equal(starts.at(-1), 18000);
  assert.equal(second.lastRequestAt, 18000);
});

test('persisted request spacing and cooldown survive worker recreation', async () => {
  let now = 1000000;
  const local = { chatGPTRequestInterval: 3, chatGPTLastRequestAt: now - 1000 };
  const args = [];
  const makeContext = () => {
    const context = vm.createContext({ Date: class extends Date { static now() { return now; } }, chrome: {
      tabs: { onUpdated: events }, alarms: { onAlarm: events },
      storage: { local: { async get() { return { ...local }; }, async set(value) { Object.assign(local, value); } } },
      scripting: { async executeScript(options) {
        args.push(options.args);
        assert.equal(local.chatGPTLastRequestAt, now + 2000); // Reserved before injection.
        return [{ result: { identity: 'user:personal', lastRequestAt: now + 2000 } }];
      } }
    } });
    vm.runInContext(source, context);
    context.chatGPTBackupProgress = async () => {};
    return context;
  };
  await makeContext().chatGPTReadPage(20, '', 'conversation', 'chat');
  assert.equal(args[0][4], 3000);
  assert.equal(args[0][5], now - 1000);
  assert.equal(local.chatGPTLastRequestAt, now + 2000);
  local.chatGPTBackupRetryAt = now + 60000;
  await assert.rejects(makeContext().chatGPTReadPage(20, '', 'list', 'recent'), /cooldown/);
  assert.equal(args.length, 1);
});

test('backoff recovery requires successful backend reads beyond the cooldown, not time spent waiting', async () => {
  let now = 1000000;
  const local = { chatGPTRateLimitCount: 4, chatGPTBackupRetryAt: now - 1000 };
  let requests = [['download', 200]];
  const context = vm.createContext({ Date: class extends Date { static now() { return now; } }, chrome: {
    tabs: { onUpdated: events }, alarms: { onAlarm: events },
    storage: { local: { async get() { return { ...local }; }, async set(value) { Object.assign(local, value); } } },
    scripting: { async executeScript() { return [{ result: { identity: 'user:personal', requests } }]; } }
  } });
  vm.runInContext(source, context);
  context.chatGPTBackupProgress = async () => {};
  await context.chatGPTReadPage(20, '', 'conversation', 'chat');
  assert.equal(local.chatGPTRateLimitCount, 4);
  now += 300000; requests = [];
  await context.chatGPTReadPage(20, '', 'identity');
  assert.equal(local.chatGPTRateLimitCount, 4);
  requests = [['inventory', 200]];
  await context.chatGPTReadPage(20, '', 'list', 'recent');
  assert.equal(local.chatGPTRateLimitCount, 0);
});

test('Sync and account-label changes retain the shared cooldown', async () => {
  const local = { chatGPTBackupEnabled: false, chatGPTBackupScope: 'old', chatGPTBackupRetryAt: Date.now() + 120000, chatGPTRateLimitCount: 3 };
  const until = local.chatGPTBackupRetryAt;
  const context = vm.createContext({ chrome: {
    runtime: { getURL: path => `chrome-extension://test/${path}` },
    tabs: { onUpdated: events }, alarms: { onAlarm: events, async create() {} },
    storage: { local: { async get() { return { ...local }; }, async set(value) { Object.assign(local, value); } } }
  } });
  vm.runInContext(source, context);
  context.chatGPTBackupRun = async () => {};
  const response = await new Promise(resolve => context.handleChatGPTBackup({ action: 'sync', scope: 'new' }, { url: 'chrome-extension://test/popup.html' }, resolve));
  assert.equal(response.ok, true);
  assert.equal(local.chatGPTBackupScope, 'new');
  assert.equal(local.chatGPTBackupRetryAt, until);
  assert.equal(local.chatGPTRateLimitCount, 3);
});

test('backoff grows across rate limits, caps client delay, and honors longer Retry-After', async () => {
  const local = { chatGPTMaxBackoffMinutes: 3 };
  const context = vm.createContext({ Math: Object.assign(Object.create(Math), { random: () => 0 }), chrome: {
    tabs: { onUpdated: events }, alarms: { onAlarm: events },
    storage: { local: { async get() { return { ...local }; }, async set(value) { Object.assign(local, value); } } }
  } });
  vm.runInContext(source, context);
  for (const seconds of [60, 120, 180, 180]) {
    const error = new Error('429');
    await context.chatGPTBackupRateLimit(error);
    assert.equal(error.retrySeconds, seconds);
    assert.match(error.message, /Shared cooldown/);
  }
  assert.equal(local.chatGPTRateLimitCount, 4);
  const long = Object.assign(new Error('429'), { retrySeconds: 1200 });
  await context.chatGPTBackupRateLimit(long);
  assert.equal(long.retrySeconds, 1200);
  assert.ok(local.chatGPTBackupRetryAt >= Date.now() + 1199000);
});

test('request diagnostics separate inventory, downloads and authentication before reporting errors', async () => {
  const logs = [];
  const context = vm.createContext({ chrome: {
    tabs: { onUpdated: events }, alarms: { onAlarm: events },
    storage: { local: { async get() { return {}; }, async set() {} } },
    scripting: { async executeScript() { return [{ result: { error: 'throttled', status: 429, requests: [['authentication', 200], ['inventory', 429]] } }]; } }
  } });
  vm.runInContext(source, context);
  context.chatGPTBackupProgress = async message => logs.push(message);
  await assert.rejects(context.chatGPTReadPage(20, '', 'list', 'recent'), /throttled/);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /inventory=1 · download=0 · authentication=1/);
  assert.match(logs[0], /outcomes=authentication:200, inventory:429/);
});

test('worker resumes pages on the same tab and shares rate-limit cooldown across inventory and downloads', async () => {
  const local = { chatGPTBackupEnabled: true, chatGPTBackupScope: 'scope' }, session = {}, actions = [], reads = [];
  let downloaded = false, claims = 0, locked = false;
  const context = vm.createContext({ URL, AbortSignal, setTimeout: fn => fn(), navigator: { locks: { async request(name, options, fn) { assert.equal(name, "chatgpt-backup"); assert.equal(options.ifAvailable, true); if (locked) return fn(null); locked = true; try { await fn({}); } finally { locked = false; } } } }, chrome: {
    tabs: { onUpdated: events, async query() { return [{ id: 10, url: 'https://chatgpt.com/' }]; }, async create(options) { assert.equal(options.active, false); return { id: 20 }; }, async get() { return { status: 'complete', url: 'https://chatgpt.com/' }; }, async remove() {} },
    alarms: { onAlarm: events }, permissions: { async contains() { return true; } },
    storage: { local: { async get() { return local; }, async set(data) { Object.assign(local, data); } }, session: { async get() { return session; }, async set(data) { Object.assign(session, data); }, async remove(key) { delete session[key]; } } }
  } });
  vm.runInContext(source, context);
  context.chatGPTBackupCounts = async () => {};
  context.chatGPTReadPage = async (tab, identity, kind, id, cursor) => { assert.equal(tab, 20); reads.push([kind, cursor || ""]); return { identity: 'user:personal', data: { fixture: true } }; };
  context.chatGPTArchive = async (action, body) => {
    actions.push(action);
    if (action.startsWith('checkpoint?')) return { checkpoint: { identity: 'user:personal', complete: true } };
    if (action === 'claim') { if (claims === 2) return { job: null }; claims++; downloaded = false; return { job: { id: `chat-${claims}`, title: 'Chat', generation: 1, lease: 'lease' } }; }
    if (action === 'pages') return { cursor: 'older', pages: downloaded ? 2 : 1, complete: downloaded };
    if (action === 'verify') return { matches: true };
    if (action === 'page') { assert.equal(body.cursor, 'older'); downloaded = true; }
    return {};
  };
  await context.chatGPTBackupRun();
  assert.equal(claims, 2);
  assert.deepEqual(reads, [['identity', ''], ['conversation', ''], ['conversation', 'older'], ['conversation', ''], ['conversation', 'older']]);
  assert.ok(actions.includes('complete'));
  assert.ok(local.chatGPTBackupSavedAt);
  assert.equal(session.chatGPTBackupTabId, undefined);
  // An inventory 429 blocks queue claims and survives subsequent Sync attempts.
  let refreshClaims = 0;
  context.chatGPTInventory = async () => { throw Object.assign(new Error('Inventory throttled'), { status: 429, retrySeconds: 120 }); };
  context.chatGPTArchive = async action => {
    if (action.startsWith('checkpoint?')) return { checkpoint: { identity: 'user:personal', complete: false, completedAt: 0 } };
    if (action === 'claim') { refreshClaims++; return { job: null }; }
    return {};
  };
  await context.chatGPTBackupRun();
  assert.equal(refreshClaims, 0);
  assert.ok(local.chatGPTBackupRetryAt > Date.now());
  await context.chatGPTBackupRun(true);
  assert.equal(refreshClaims, 0);
  // Other inventory failures leave downloads eligible.
  delete local.chatGPTBackupRetryAt;
  context.chatGPTInventory = async () => { throw new Error('Inventory network failure'); };
  await context.chatGPTBackupRun();
  assert.equal(refreshClaims, 1);
  assert.equal(local.chatGPTBackupRetryAt, undefined);
  // Shared cooldown blocks inventory too; a second worker cannot overlap it.
  delete local.chatGPTInventoryRetryAt;
  local.chatGPTBackupRetryAt = Date.now() + 120000;
  let inventoryRuns = 0, finishInventory;
  context.chatGPTInventory = async () => { inventoryRuns++; await new Promise(resolve => { finishInventory = resolve; }); return true; };
  await context.chatGPTBackupRun();
  assert.equal(inventoryRuns, 0);
  delete local.chatGPTBackupRetryAt;
  const running = context.chatGPTBackupRun();
  while (!finishInventory) await new Promise(resolve => setImmediate(resolve));
  await context.chatGPTBackupRun();
  assert.equal(inventoryRuns, 1);
  finishInventory();
  await running;
  assert.equal(refreshClaims, 2);
  // A rate limit stops the batch immediately, rather than claiming another job.
  let limitedClaims = 0;
  context.chatGPTArchive = async action => {
    if (action.startsWith('checkpoint?')) return { checkpoint: { identity: 'user:personal', complete: true } };
    if (action === 'claim') { limitedClaims++; return { job: { id: 'limited', generation: 1, lease: 'lease' } }; }
    if (action === 'pages') return { pages: 0, cursor: '', complete: false };
    return {};
  };
  context.chatGPTReadPage = async (tab, identity, kind) => {
    if (kind === 'identity') return { identity: 'user:personal' };
    throw Object.assign(new Error('Too many requests'), { status: 429, retrySeconds: 120 });
  };
  await context.chatGPTBackupRun();
  assert.equal(limitedClaims, 1);
  assert.ok(local.chatGPTBackupRetryAt > Date.now());
  delete local.chatGPTBackupRetryAt;
  // Without an authenticated checkpoint, old preview rows cannot be claimed.
  context.chatGPTArchive = async action => { if (action.startsWith('checkpoint?')) return { checkpoint: null }; if (action === 'claim') throw new Error('must not claim'); return {}; };
  context.chatGPTInventory = async () => false;
  await context.chatGPTBackupRun();
  assert.equal(claims, 2);
});

test('backup summary distinguishes durable backups from mutually exclusive queue states', async () => {
  let summary;
  const context = vm.createContext({
    async chatGPTArchive() { return { root: '/archive', conversations: [
      { title: 'Current', saved_at: 1, generation: 1, saved_generation: 1 },
      { title: 'Refresh', saved_at: 1, generation: 2, saved_generation: 1 },
      { title: 'New', generation: 1, saved_generation: 0 },
      { title: 'Fetching', generation: 1, saved_generation: 0, lease_until: Date.now() / 1000 + 60, error: 'Prior error' },
      { title: 'Retry', generation: 1, saved_generation: 0, error: 'No supported messages' }
    ] }; },
    chrome: { storage: { local: { async set(value) { summary = value.chatGPTBackupSummary; } } } }
  });
  vm.runInContext(source.slice(source.indexOf('async function chatGPTBackupCounts('), source.indexOf('async function chatGPTBackupActive(')), context);
  await context.chatGPTBackupCounts('account');
  assert.match(summary, /5 known · 2 have backups · 3 have no backup/);
  assert.match(summary, /1 first backups · 1 refreshes · 1 fetching · 1 awaiting retry/);
  assert.match(summary, /Retry: No supported messages/);
  assert.match(summary, /Inventory: incomplete; discovered conversations can download/);
});

test('automatic discovery persists requests, coalesces navigation, and ignores owned tabs and pause', async () => {
  const local = { chatGPTBackupEnabled: true };
  const session = { chatGPTBackupTabId: 20 };
  let tabs = [{ id: 10, url: 'https://chatgpt.com/c/chat-a' }];
  let now = 1000000, runs = 0;
  const listeners = {};
  const context = vm.createContext({
    Date: { now: () => now },
    chrome: {
      storage: {
        local: { async get() { return local; }, async set(data) { Object.assign(local, data); } },
        session: { async get() { return session; } }
      },
      tabs: { async query() { return tabs; }, onUpdated: { addListener(fn) { listeners.updated = fn; } } },
      alarms: { onAlarm: { addListener(fn) { listeners.alarm = fn; } } }
    },
    async chatGPTBackupRun() { runs++; },
    async chatGPTBackupProgress(message) { throw new Error(message); }
  });
  vm.runInContext(source.slice(source.indexOf('async function chatGPTBackupAutoRequest(')), context);
  await listeners.updated(20, { status: 'complete' }, { id: 20, url: 'https://chatgpt.com/' });
  assert.equal(local.chatGPTBackupRequestedAt, undefined);
  await listeners.updated(10, { url: tabs[0].url }, tabs[0]);
  assert.equal(local.chatGPTBackupRequestedAt, now);
  assert.equal(runs, 1);
  await listeners.updated(10, { status: 'complete' }, tabs[0]);
  assert.equal(runs, 1);
  now += 300001;
  await listeners.alarm({ name: 'chatgpt-backup' });
  assert.equal(local.chatGPTBackupRequestedAt, now);
  // No eligible user tab: periodic discovery must not feed on the worker tab.
  now += 300001;
  tabs = [{ id: 20, url: 'https://chatgpt.com/' }];
  assert.equal(await context.chatGPTBackupAutoRequest(), false);
  tabs = [{ id: 10, url: 'https://example.com/' }];
  assert.equal(await context.chatGPTBackupAutoRequest(), false);
  local.chatGPTBackupEnabled = false;
  assert.equal(await context.chatGPTBackupAutoRequest({ id: 10, url: 'https://chatgpt.com/' }), false);
});

test('backup preview controls load in the real extension panel', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'website-reader-chatgpt-preview-'));
  const extension = path.resolve(import.meta.dirname, '..');
  const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  try {
    let [worker] = context.serviceWorkers();
    worker ||= await context.waitForEvent('serviceworker');
    const page = await context.newPage();
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/popup.html`);
    await page.locator('#chatgpt-backup > summary').click();
    await page.getByLabel('Account and workspace label', { exact: true }).fill('personal');
    const scopeInput = page.getByLabel('Account and workspace label', { exact: true });
    await scopeInput.fill('work_account-1');
    assert.equal(await scopeInput.evaluate(e => e.checkValidity()), true);
    await scopeInput.fill('invalid scope');
    assert.equal(await scopeInput.evaluate(e => e.validity.patternMismatch), true);
    await scopeInput.fill('personal');
    assert.equal(await page.getByRole('button', { name: 'Sync conversations', exact: true }).isVisible(), true);
    assert.equal(await page.getByLabel('Minimum request interval (seconds)', { exact: true }).inputValue(), '2');
    assert.equal(await page.getByLabel('Maximum retry backoff (minutes)', { exact: true }).inputValue(), '15');
    await page.getByLabel('Minimum request interval (seconds)', { exact: true }).fill('0');
    await page.getByRole('button', { name: 'Save backup settings', exact: true }).click();
    assert.equal(await worker.evaluate(async () => (await chrome.storage.local.get('chatGPTRequestInterval')).chatGPTRequestInterval), undefined);
    await page.getByLabel('Minimum request interval (seconds)', { exact: true }).fill('3');
    await page.getByLabel('Maximum retry backoff (minutes)', { exact: true }).fill('10');
    const cooldown = Date.now() + 120000;
    await worker.evaluate(async until => chrome.storage.local.set({ chatGPTBackupRetryAt: until }), cooldown);
    await page.getByRole('button', { name: 'Save backup settings', exact: true }).click();
    await page.getByText('Backup settings saved. Active cooldowns are retained.', { exact: true }).waitFor();
    assert.equal(await worker.evaluate(async () => (await chrome.storage.local.get('chatGPTBackupRetryAt')).chatGPTBackupRetryAt), cooldown);
    await page.locator('#chatgpt-backup-cooldown').filter({ hasText: 'next retry no earlier than' }).waitFor();
    await page.getByRole('button', { name: 'Pause backup', exact: true }).click();
    await page.getByText('Paused. Saved snapshots and queued conversations are retained.', { exact: true }).waitFor();
    assert.equal(await worker.evaluate(async () => (await chrome.storage.local.get('chatGPTBackupEnabled')).chatGPTBackupEnabled), false);
    await worker.evaluate(async () => chrome.storage.local.set({
      chatGPTBackupSummary: '12 known · 8 have backups · 4 have no backup.\nQueue: 3 first backups · 0 refreshes · 0 fetching · 1 awaiting retry. Destination: /archive',
      chatGPTBackupUpdatedAt: Date.now(), chatGPTBackupSavedAt: Date.now()
    }));
    await page.getByText(/12 known · 8 have backups · 4 have no backup/).waitFor();
    await page.getByText(/Last successful save:/).waitFor();
    assert.equal(await page.getByLabel('Account and workspace label', { exact: true }).inputValue(), 'personal');
    await page.reload();
    await page.locator('#chatgpt-backup > summary').click();
    await page.getByText(/12 known · 8 have backups · 4 have no backup/).waitFor();
    assert.equal(await page.getByLabel('Minimum request interval (seconds)', { exact: true }).inputValue(), '3');
    assert.equal(await page.getByLabel('Maximum retry backoff (minutes)', { exact: true }).inputValue(), '10');
    await page.getByText('Backup diagnostic log (last 200 events)', { exact: true }).click();
    assert.equal(await page.getByRole('button', { name: 'Download backup log', exact: true }).isVisible(), true);
    await page.locator('#chatgpt-backup-log').filter({ hasText: 'Paused. Saved snapshots' }).waitFor();
    await page.screenshot({ path: '/private/tmp/chatgpt-backup-preview.png', fullPage: true });
  } finally { await context.close(); await fs.rm(profile, { recursive: true, force: true }); }
});
