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
  incremental = true; calls.length = 0;
  assert.equal(await context.chatGPTInventory(20, 'scope', checkpoint), true);
  assert.equal(calls.filter(x => x[1] === 'recent').length, 2); // page plus head revalidation
  assert.ok(calls.filter(x => x[1] === 'recent').every(x => x[2] === ''));
  assert.ok(commits.at(-1).checkpoint.completedAt);
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
  assert.deepEqual(calls, ['1', '']); // cursor resume, then head revalidation
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
  account = { structure: 'workspace', account_id: null };
  assert.match((await context.chatGPTRead('identity')).error, /matching entry: true; type: workspace/);
  account = { structure: 'workspace', account_id: 'team' };
  assert.equal((await context.chatGPTRead('identity')).identity, 'user:default');
  context.document.cookie = '_account=%22team%22';
  assert.equal((await context.chatGPTRead('identity')).identity, 'user:team');
  context.document.cookie = '_account=missing';
  assert.match((await context.chatGPTRead('identity')).error, /matching entry: false/);
  context.fetch = async () => ({ ok: false, status: 429, headers: { get: () => '120' } });
  const limited = await context.chatGPTRead('identity');
  assert.equal(limited.status, 429);
  assert.equal(limited.retrySeconds, 120);
  assert.doesNotMatch(JSON.stringify(limited), /private-token/);
});

test('worker resumes saved conversation pages on its owned tab, one conversation at a time', async () => {
  const local = { chatGPTBackupEnabled: true, chatGPTBackupScope: 'scope' }, session = {}, actions = [], reads = [];
  let downloaded = false, claims = 0;
  const context = vm.createContext({ URL, AbortSignal, setTimeout: fn => fn(), navigator: { locks: { async request(name, options, fn) { await fn({}); } } }, chrome: {
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
    if (action === 'claim') { claims++; return { job: { id: 'chat', title: 'Chat', generation: 1, lease: 'lease' } }; }
    if (action === 'pages') return { cursor: 'older', pages: downloaded ? 2 : 1, complete: downloaded };
    if (action === 'verify') return { matches: true };
    if (action === 'page') { assert.equal(body.cursor, 'older'); downloaded = true; }
    return {};
  };
  await context.chatGPTBackupRun();
  assert.equal(claims, 1);
  assert.deepEqual(reads, [['identity', ''], ['conversation', ''], ['conversation', 'older']]);
  assert.ok(actions.includes('complete'));
  assert.ok(local.chatGPTBackupSavedAt);
  assert.equal(session.chatGPTBackupTabId, undefined);
  // Incomplete inventory blocks all download claims, even with old preview rows.
  context.chatGPTArchive = async action => { if (action.startsWith('checkpoint?')) return { checkpoint: null }; if (action === 'claim') throw new Error('must not claim'); return {}; };
  context.chatGPTInventory = async () => false;
  await context.chatGPTBackupRun();
  assert.equal(claims, 1);
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
  assert.match(summary, /Inventory: incomplete; downloads wait/);
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
    await page.getByText('Backup diagnostic log (last 200 events)', { exact: true }).click();
    assert.equal(await page.getByRole('button', { name: 'Download backup log', exact: true }).isVisible(), true);
    await page.locator('#chatgpt-backup-log').filter({ hasText: 'Paused. Saved snapshots' }).waitFor();
    await page.screenshot({ path: '/private/tmp/chatgpt-backup-preview.png', fullPage: true });
  } finally { await context.close(); await fs.rm(profile, { recursive: true, force: true }); }
});
