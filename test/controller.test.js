const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const path = require('path');
const { useTempDataDir } = require('./helpers');

const dir = useTempDataDir();
const { DesktopController } = require('../src/desktop/controller');
const { SettingsStore } = require('../src/settings/settingsStore');
const schema = require('../src/settings/schema');

let n = 0;
function setup({ connectionOk = true, emojiErrors = {}, autostartOk = true } = {}) {
  const ui = new EventEmitter();
  ui.sent = [];
  ui.send = (m) => { ui.sent.push(JSON.parse(JSON.stringify(m))); return true; };
  const hosting = new EventEmitter();
  hosting.status = { state: 'stopped', role: 'off', detail: '', error: null };
  hosting.calls = [];
  hosting.start = async () => { hosting.calls.push('start'); hosting.status = { ...hosting.status, state: 'running', role: 'standby' }; };
  hosting.stop = async () => { hosting.calls.push('stop'); hosting.status = { ...hosting.status, state: 'stopped', role: 'off' }; };
  const monitor = new EventEmitter();
  monitor.snapshot = { loading: true };
  monitor.refresh = async () => {};
  monitor.setVisible = (v) => { monitor.visible = v; };
  const autostart = { calls: [], setAutoStart(v) { this.calls.push(v); return autostartOk ? { ok: true } : { ok: false, error: 'denied' }; } };
  const store = new SettingsStore(path.join(dir, `s${++n}.json`)).load();
  const exits = [];
  const c = new DesktopController({
    ui, hosting, store, monitor, autostart,
    connection: { ok: connectionOk, missing: connectionOk ? [] : ['DISCORD_BOT_TOKEN'], hasCoordinationChannel: true, hasEventChannel: true, autoEventEnabled: true },
    checkEmojis: async () => ({ errors: emojiErrors, warnings: [] }),
    applyChange: () => ({ warnings: [], changedDays: ['monday'] }),
    requestExit: (reason) => exits.push(reason),
  });
  const request = async (msg) => {
    ui.sent = [];
    await c.handle(msg);
    return ui.sent.find((m) => m.type === 'response' && m.id === msg.id);
  };
  return { c, ui, hosting, store, autostart, monitor, exits, request };
}

test('ready pushes settings and status, never connection values', async () => {
  process.env.DISCORD_BOT_TOKEN = 'super-secret-token';
  try {
    const { c, ui } = setup();
    await c.handle({ type: 'ready' });
    assert.deepEqual(ui.sent.map((m) => m.type), ['settings', 'status']);
    assert.ok(!JSON.stringify(ui.sent).includes('super-secret-token'));
    assert.equal(ui.sent[0].values.AUTO_EVENT_TITLE, schema.DEFAULTS.AUTO_EVENT_TITLE);
  } finally {
    delete process.env.DISCORD_BOT_TOKEN;
  }
});

test('hosting ON persists, enables sign-in startup and starts hosting', async () => {
  const { store, autostart, hosting, request } = setup();
  const r = await request({ type: 'setHosting', id: 1, enabled: true });
  assert.equal(r.ok, true);
  assert.equal(store.isHostingEnabled(), true);
  assert.deepEqual(autostart.calls, [true]);
  assert.deepEqual(hosting.calls, ['start']);
});

test('hosting OFF persists, disables sign-in startup and waits for a clean stop', async () => {
  const { store, autostart, hosting, request } = setup();
  await request({ type: 'setHosting', id: 1, enabled: true });
  const r = await request({ type: 'setHosting', id: 2, enabled: false });
  assert.equal(r.ok, true);
  assert.equal(store.isHostingEnabled(), false);
  assert.deepEqual(autostart.calls, [true, false]);
  assert.deepEqual(hosting.calls, ['start', 'stop']);
});

test('hosting ON is refused without a Discord connection', async () => {
  const { store, hosting, request } = setup({ connectionOk: false });
  const r = await request({ type: 'setHosting', id: 1, enabled: true });
  assert.equal(r.ok, false);
  assert.match(r.error, /DISCORD_BOT_TOKEN/);
  assert.equal(store.isHostingEnabled(), false);
  assert.deepEqual(hosting.calls, []);
});

test('auto-start failure is reported as a warning, hosting still turns on', async () => {
  const { request } = setup({ autostartOk: false });
  const r = await request({ type: 'setHosting', id: 1, enabled: true });
  assert.equal(r.ok, true);
  assert.match(r.warnings[0], /denied/);
});

test('save returns per-field errors and keeps settings unchanged', async () => {
  const { store, request } = setup();
  const r = await request({ type: 'saveSettings', id: 1, settings: { ...schema.DEFAULTS, AUTO_EVENT_SCHEDULE: '7pm', FLEX_EMOJI: 'flex' } });
  assert.equal(r.ok, false);
  assert.ok(r.fieldErrors.AUTO_EVENT_SCHEDULE);
  assert.ok(r.fieldErrors.FLEX_EMOJI);
  assert.equal(store.getEffective().AUTO_EVENT_SCHEDULE, schema.DEFAULTS.AUTO_EVENT_SCHEDULE);
});

test('unusable custom emoji blocks the save', async () => {
  const { store, request } = setup({ emojiErrors: { FLEX_EMOJI: "The bot can't use :x:" } });
  const r = await request({ type: 'saveSettings', id: 1, settings: { ...schema.DEFAULTS, FLEX_EMOJI: '<:xx:123456789012345678>' } });
  assert.equal(r.ok, false);
  assert.ok(r.fieldErrors.FLEX_EMOJI);
  assert.equal(store.getEffective().FLEX_EMOJI, schema.DEFAULTS.FLEX_EMOJI);
});

test('successful save returns normalized values and a summary', async () => {
  const { request } = setup();
  const r = await request({ type: 'saveSettings', id: 1, settings: { ...schema.DEFAULTS, AUTO_EVENT_SCHEDULE: '9:00', AUTO_EVENT_TITLE: ' Raid ' } });
  assert.equal(r.ok, true);
  assert.equal(r.values.AUTO_EVENT_SCHEDULE, '09:00');
  assert.equal(r.values.AUTO_EVENT_TITLE, 'Raid');
  assert.match(r.message, /Mon/);
});

test('visibility, exit and end-session messages are routed', async () => {
  const { c, monitor, exits } = setup();
  await c.handle({ type: 'visibility', visible: true });
  assert.equal(monitor.visible, true);
  await c.handle({ type: 'exit' });
  await c.handle({ type: 'endSession' });
  assert.deepEqual(exits, ['tray', 'endSession']);
});
