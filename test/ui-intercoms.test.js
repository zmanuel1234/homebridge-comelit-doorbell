// Runs the settings page's own script against a small fake page and a fake Homebridge, to check
// what several intercoms do: switching, adding, removing, and results that arrive late.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'homebridge-ui', 'public', 'index.html'), 'utf8');
const script = html.slice(html.lastIndexOf('<script>') + '<script>'.length, html.lastIndexOf('</script>'));

function element(id) {
  const listeners = {};
  const classes = new Set();
  return {
    id,
    innerHTML: '',
    textContent: '',
    value: '',
    files: [],
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      toggle: (c, on) => (on ?? !classes.has(c) ? classes.add(c) : classes.delete(c)),
      replace: (a, b) => classes.delete(a) && classes.add(b),
      contains: (c) => classes.has(c),
    },
    addEventListener: (type, f) => ((listeners[type] ??= []).push(f)),
    fire: async (type) => {
      for (const f of listeners[type] ?? []) {
        await f({});
      }
    },
    querySelectorAll: () => [],
    focus() {},
    select() {},
    click() {},
  };
}

/** The page, run with `blocks` as the plugin's config. `requests` answers each request path. */
function page(blocks, requests = {}) {
  const els = new Map();
  const $ = (id) => {
    if (!els.has(id)) els.set(id, element(id));
    return els.get(id);
  };
  let config = JSON.parse(JSON.stringify(blocks));
  const toasts = [];
  const sent = [];
  const listeners = {};
  const homebridge = {
    getPluginConfig: async () => JSON.parse(JSON.stringify(config)),
    // As Homebridge: each block is merged into the one at its place; undefined clears a key.
    updatePluginConfig: async (next) => {
      config = next.map((b, i) => {
        const merged = { ...(config[i] ?? {}), ...b };
        for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];
        return merged;
      });
      for (const f of listeners.configChanged ?? []) f({ data: JSON.parse(JSON.stringify(config)) });
      return config;
    },
    request: async (p, body) => {
      sent.push({ p, body });
      return (requests[p] ?? (() => []))(body);
    },
    addEventListener: (type, f) => ((listeners[type] ??= []).push(f)),
    showSchemaForm() {},
    hideSchemaForm() {},
    showSpinner() {},
    hideSpinner() {},
    toast: { success: (m) => toasts.push(['ok', m]), error: (m) => toasts.push(['error', m]), info: (m) => toasts.push(['info', m]) },
  };
  const context = {
    document: { getElementById: $, createElement: () => element('new') },
    homebridge,
    navigator: {},
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    setTimeout,
    clearTimeout,
    Uint8Array,
    String,
    Number,
    Date,
    Object,
    Set,
    Array,
    JSON,
  };
  vm.runInNewContext(script, context);
  return { $, homebridge, toasts, sent, config: () => JSON.parse(JSON.stringify(config)) };
}

const settle = () => new Promise((r) => setTimeout(r, 20));
const A = { platform: 'ComelitIntercom', name: 'Front', host: '10.0.0.1', token: 'a', actuators: { Light: 'switch' } };
const B = { platform: 'ComelitIntercom', name: 'Back', host: '10.0.0.2', token: 'b', _bridge: { username: 'BB' } };

async function choose(p, name) {
  await settle();
  const index = p.config().findIndex((b) => b.name === name);
  p.$('which').value = String(index);
  await p.$('which').fire('change');
  await settle();
}

test('ui: switching moves the chosen intercom to the front and keeps every setting of both', async () => {
  const p = page([A, B]);
  await choose(p, 'Back');
  assert.deepStrictEqual(p.config(), [B, A]);
  await choose(p, 'Front');
  assert.deepStrictEqual(p.config(), [A, B]);
});

test('ui: the menu lists the intercoms in name order, whichever is chosen', async () => {
  const p = page([A, B]);
  await settle();
  const order = () => [...p.$('which').innerHTML.matchAll(/>([^<]+)</g)].map((m) => m[1]);
  assert.deepStrictEqual(order(), ['Back (10.0.0.2)', 'Front (10.0.0.1)']);
  await choose(p, 'Back');
  assert.deepStrictEqual(order(), ['Back (10.0.0.2)', 'Front (10.0.0.1)']);
});

test('ui: Remove asks once, then removes the intercom shown', async () => {
  const p = page([A, B]);
  await settle();
  await p.$('removeIntercom').fire('click');
  assert.strictEqual(p.$('removeIntercom').textContent, 'Remove Front?');
  await p.$('removeIntercom').fire('click');
  await settle();
  assert.deepStrictEqual(p.config(), [B]);
});

test('ui: an armed Remove is reset by switching, and never removes the other intercom', async () => {
  const p = page([A, B]);
  await settle();
  await p.$('removeIntercom').fire('click');
  assert.strictEqual(p.$('removeIntercom').textContent, 'Remove Front?');
  await choose(p, 'Back');
  assert.strictEqual(p.$('removeIntercom').textContent, 'Remove');
  await p.$('removeIntercom').fire('click'); // asks again, now for Back
  assert.strictEqual(p.$('removeIntercom').textContent, 'Remove Back?');
  assert.strictEqual(p.config().length, 2);
  await p.$('removeIntercom').fire('click');
  await settle();
  assert.deepStrictEqual(p.config(), [A], 'the one it asked about');
});

test('ui: renaming the intercom shown resets an armed Remove', async () => {
  const p = page([A, B]);
  await settle();
  await p.$('removeIntercom').fire('click');
  assert.strictEqual(p.$('removeIntercom').textContent, 'Remove Front?');
  const blocks = await p.homebridge.getPluginConfig();
  blocks[0].name = 'Garden';
  await p.homebridge.updatePluginConfig(blocks);
  assert.strictEqual(p.$('removeIntercom').textContent, 'Remove');
});

test('ui: a search that fails after switching says nothing, and the spinner waits for the newer one', async () => {
  const answers = [];
  let spinner = 0;
  const p = page([A, B], { '/discover': () => new Promise((r, j) => answers.push({ r, j })) });
  p.homebridge.showSpinner = () => { spinner = 1; };
  p.homebridge.hideSpinner = () => { spinner = 0; };
  await settle();
  const first = p.$('find').fire('click');
  await settle();
  await choose(p, 'Back');
  const second = p.$('find').fire('click');
  await settle();
  answers[0].j(new Error('timeout'));
  await first;
  assert.strictEqual(spinner, 1, 'still searching for Back');
  assert.ok(!p.toasts.some(([kind]) => kind === 'error'));
  answers[1].r([]);
  await second;
  assert.strictEqual(spinner, 0);
  assert.match(p.$('found').innerHTML, /No Comelit device answered/);
});

test('ui: Add puts a new intercom in front and keeps the others', async () => {
  const p = page([A, B]);
  await settle();
  await p.$('addIntercom').fire('click');
  await settle();
  assert.deepStrictEqual(p.config().slice(1), [A, B]);
  assert.strictEqual(p.config()[0].name, 'Comelit Intercom 3');
});

test('ui: a test result that arrives after switching is dropped, and cannot change the other intercom', async () => {
  let answer;
  const p = page([A, B], { '/test': () => new Promise((r) => (answer = r)) });
  await settle();
  const running = p.$('test').fire('click');
  await settle();
  await choose(p, 'Back');
  answer({ steps: [{ name: 'User row', ok: false, detail: 'wrong' }], subaddress: 7, diagnostics: '' });
  await running;
  assert.strictEqual(p.$('result').innerHTML, '', 'nothing shown under Back');
  assert.strictEqual(p.config()[0].subaddress, undefined);
});

test('ui: the same name, or names differing only in capitals or punctuation, are flagged', async () => {
  const p = page([A, { ...B, name: 'front!' }]);
  await settle();
  assert.match(p.$('intercomNotes').innerHTML, /same <b>Name<\/b>/);
  const q = page([A, B]);
  await settle();
  assert.doesNotMatch(q.$('intercomNotes').innerHTML, /same <b>Name<\/b>/);
  assert.match(q.$('intercomNotes').innerHTML, /child bridge/, 'Front has no child bridge yet');
});

test('ui: one intercom shows no menu, no Remove and no warnings', async () => {
  const p = page([A]);
  await settle();
  assert.ok(p.$('which').classList.contains('d-none'));
  assert.ok(p.$('removeIntercom').classList.contains('d-none'));
  assert.strictEqual(p.$('intercomNotes').innerHTML, '');
});
