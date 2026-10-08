import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const code = await fs.readFile(new URL('../popup.js', import.meta.url), 'utf8');
test('collection controls distinguish current page, saved progress, and attachment', () => {
  const control = () => ({ disabled: false, hidden: false, textContent: '' });
  const context = vm.createContext({
    attachmentFile: { files: [] }, attachmentStatus: control(), useBatchButton: control(),
    handoffButton: control(), collectButton: control(), continueButton: control(), skipButton: control(),
    logOutput: control(), downloadLogButton: control(), handoffRunning: false,
    activeEditionUrl: 'https://www.economist.com/weeklyedition/2026-10-03', economistLanding: false,
    emails: [], publicationName: () => 'The Economist', setStatus(message) { context.lastStatus = message; }
  });
  vm.runInContext(code.slice(code.indexOf('function renderState('), code.indexOf('async function download(')), context);
  for (const status of [undefined, 'running', 'paused', 'completed']) {
    context.renderState(status ? { status, editionUrl: 'https://mail.google.com/', filename: 'medium.md' } : undefined);
    assert.equal(context.collectButton.disabled, status === 'running');
    assert.equal(context.continueButton.hidden, status !== 'paused');
    assert.equal(context.handoffButton.disabled, status !== 'completed');
  }
  context.attachmentFile.files = [{ name: 'economist.md' }];
  context.renderState({ status: 'paused' });
  assert.equal(context.handoffButton.disabled, false);
  assert.equal(context.attachmentStatus.textContent, 'File to open in ChatGPT: economist.md\nSource: chosen file.');
  assert.equal(context.useBatchButton.textContent, 'Clear chosen file');
  context.renderState({ status: 'completed', filename: 'medium.md' });
  assert.equal(context.attachmentStatus.textContent, 'File to open in ChatGPT: economist.md\nSource: chosen file.');
  assert.equal(context.useBatchButton.textContent, 'Use saved collection instead');
  context.handoffRunning = true;
  context.renderState({ status: 'completed', filename: 'medium.md' });
  assert.equal(context.handoffButton.disabled, true);
  assert.equal(context.attachmentFile.disabled, true);
  context.handoffRunning = false;
  context.attachmentFile.files = [];
  context.lastStatus = 'Ready to collect the current issue.';
  context.renderState({ status: 'completed', filename: 'medium.md', emailId: 'old-email', editionUrl: 'https://mail.google.com/::old-email', statusMessage: 'Old email completed.' });
  assert.equal(context.attachmentStatus.textContent, 'File to open in ChatGPT: medium.md\nSource: latest completed collection.');
  assert.equal(context.useBatchButton.hidden, true);
  assert.equal(context.lastStatus, 'Ready to collect the current issue.');
  context.renderState(undefined);
  assert.equal(context.attachmentStatus.textContent, 'No file ready for ChatGPT. Choose a file or complete a collection.');
  assert.equal(context.handoffButton.disabled, true);
  context.economistLanding = true;
  context.activeEditionUrl = '';
  context.renderState({ status: 'completed', filename: 'medium.md' });
  assert.equal(context.collectButton.disabled, false);
  assert.equal(context.collectButton.textContent, 'Open Economist weekly edition');
});

test('starting on another issue replaces a paused batch but blocks a running batch', async () => {
  let saved = { status: 'paused', editionUrl: 'https://mail.google.com/::medium', articleTabId: 2 };
  let started = 0;
  let closed = 0;
  const context = vm.createContext({
    collectButton: {}, continueButton: {}, economistLanding: false,
    setStatus() {}, async loadState() {}, isGmailUrl: () => false,
    isIssueUrl: () => true, editionUrl: url => url, collectEdition() {},
    async readingBatchTab(resume) { assert.equal(resume, false); return { id: 3, url: 'https://www.economist.com/weeklyedition/2026-10-03' }; },
    chrome: {
      storage: { local: { async get() { return { collectionState: saved }; } } },
      tabs: { async remove(id) { assert.equal(id, 2); closed++; } },
      scripting: { async executeScript({ args }) { assert.equal(args[0], false); started++; return [{ result: { completed: true } }]; } }
    }
  });
  vm.runInContext(code.slice(code.indexOf('async function runCollection('), code.indexOf('async function collectFromClick(')), context);
  await context.runCollection(false);
  assert.equal(started, 1);
  assert.equal(closed, 1);
  saved.status = 'running';
  await context.runCollection(false);
  assert.equal(started, 1);
  assert.equal(closed, 1);
});
