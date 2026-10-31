const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const path = require('path');
const { useTempDataDir } = require('./helpers');

const dir = useTempDataDir();
const { DesktopController } = require('../src/desktop/controller');
const { SettingsStore } = require('../src/settings/settingsStore');
const schema = require('../src/settings/schema');

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const allDays = (v = true) => Object.fromEntries(DAYS.map((d) => [d, v]));
const ROLES = schema.resolveLegacyRoles({});
const settings = (o = {}) => ({ ...schema.DEFAULTS, ...o });
const save = (id, o = {}) => ({ type: 'saveSettings', id, settings: settings(o.settings), roles: o.roles || ROLES, days: o.days || allDays() });

// Stand-in for scheduler/scheduleConfig: just the roles + weekdays the UI edits.
function fakeSchedule() {
  const s = new EventEmitter();
  s.roles = ROLES.map((r) => ({ ...r }));
  s.days = allDays();
  s.getRoles = () => s.roles.map((r) => ({ ...r }));
  s.getEnabledDays = () => ({ ...s.days });
  return s;
}

let n = 0;
// Stand-in for scheduler/autoEvent: records manual posts.
function fakeAutoEvent(createNow) {
  const a = { status: new EventEmitter(), posts: 0 };
  a.getStatus = () => ({ state: 'idle', reason: 'Not running on this PC.' });
  a.createNow = createNow || (async () => { a.posts++; return { title: 'Guild Raid Signup' }; });
  return a;
}

function setup({ connectionOk = true, emojiErrors = {}, autostartOk = true, edition = 'full', role = 'off', createNow } = {}) {
  const ui = new EventEmitter();
  ui.sent = [];
  ui.send = (m) => { ui.sent.push(JSON.parse(JSON.stringify(m))); return true; };
  const hosting = new EventEmitter();
  hosting.status = { state: role === 'off' ? 'stopped' : 'running', role, detail: '', error: null };
  hosting.calls = [];
  hosting.start = async () => { hosting.calls.push('start'); hosting.status = { ...hosting.status, state: 'running', role: 'standby' }; };
  hosting.stop = async () => { hosting.calls.push('stop'); hosting.status = { ...hosting.status, state: 'stopped', role: 'off' }; };
  const monitor = new EventEmitter();
  monitor.snapshot = { loading: true };
  monitor.refresh = async () => {};
  monitor.setVisible = (v) => { monitor.visible = v; };
  const autostart = { calls: [], setAutoStart(v) { this.calls.push(v); return autostartOk ? { ok: true } : { ok: false, error: 'denied' }; } };
  const store = new SettingsStore(path.join(dir, `s${++n}.json`)).load();
  const schedule = fakeSchedule();
  const autoEvent = fakeAutoEvent(createNow);
  const exits = [];
  const checked = [];
  const c = new DesktopController({
    ui, hosting, store, schedule, monitor, autostart, edition, autoEvent,
    connection: { ok: connectionOk, missing: connectionOk ? [] : ['DISCORD_BOT_TOKEN'], hasCoordinationChannel: true, hasEventChannel: true, autoEventEnabled: true },
    checkEmojis: async (entries) => { checked.push(...entries); return { errors: emojiErrors, warnings: [] }; },
    // Mirrors settings/effects: the schedule changes (and emits) mid-save.
    applyChange: ({ roles, days }) => {
      schedule.roles = roles;
      schedule.days = days;
      schedule.emit('change');
      return { warnings: [], changedDays: ['monday'] };
    },
    requestExit: (reason) => exits.push(reason),
  });
  const request = async (msg) => {
    ui.sent = [];
    await c.handle(msg);
    return ui.sent.find((m) => m.type === 'response' && m.id === msg.id);
  };
  return { c, ui, hosting, store, schedule, autoEvent, autostart, monitor, exits, checked, request };
}

test('ready pushes settings and status, never connection values', async () => {
  process.env.DISCORD_BOT_TOKEN = 'super-secret-token';
  try {
    const { c, ui } = setup();
    await c.handle({ type: 'ready' });
    assert.deepEqual(ui.sent.map((m) => m.type), ['settings', 'status']);
    assert.ok(!JSON.stringify(ui.sent).includes('super-secret-token'));
    assert.equal(ui.sent[0].values.AUTO_EVENT_TITLE, schema.DEFAULTS.AUTO_EVENT_TITLE);
    assert.equal(ui.sent[0].roles.length, 5);
    assert.equal(ui.sent[0].days.friday, true);
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

test('save returns per-field errors for settings and roles and changes nothing', async () => {
  const { store, schedule, request } = setup();
  const roles = ROLES.map((r) => (r.key === 'flex' ? { ...r, emoji: 'flex' } : r));
  const r = await request(save(1, { settings: { AUTO_EVENT_SCHEDULE: '7pm' }, roles }));
  assert.equal(r.ok, false);
  assert.ok(r.fieldErrors.AUTO_EVENT_SCHEDULE);
  assert.ok(r.fieldErrors['roles.4.emoji']);
  assert.equal(store.getEffective().AUTO_EVENT_SCHEDULE, schema.DEFAULTS.AUTO_EVENT_SCHEDULE);
  assert.equal(schedule.roles[4].emoji, ROLES[4].emoji);
});

test('a role may not reuse the Donkey emoji', async () => {
  const { request } = setup();
  const r = await request(save(1, { roles: [{ ...ROLES[0], emoji: schema.DEFAULTS.DONKEY_EMOJI }, ...ROLES.slice(1)] }));
  assert.equal(r.ok, false);
  assert.match(r.fieldErrors['roles.0.emoji'], /Donkey/);
});

test('unusable custom emoji blocks the save', async () => {
  const { store, checked, request } = setup({ emojiErrors: { 'roles.4.emoji': "The bot can't use :x:" } });
  const roles = ROLES.map((r) => (r.key === 'flex' ? { ...r, emoji: '<:xx:123456789012345678>' } : r));
  const r = await request(save(1, { roles, settings: { AUTO_EVENT_TITLE: 'Not saved' } }));
  assert.equal(r.ok, false);
  assert.ok(r.fieldErrors['roles.4.emoji']);
  assert.deepEqual(checked.map((e) => e.key), ['roles.0.emoji', 'roles.1.emoji', 'roles.2.emoji', 'roles.3.emoji', 'roles.4.emoji', 'DONKEY_EMOJI']);
  assert.equal(store.getEffective().AUTO_EVENT_TITLE, schema.DEFAULTS.AUTO_EVENT_TITLE);
});

test('successful save stores roles and weekdays and returns them with a summary', async () => {
  const { ui, schedule, request } = setup();
  const roles = [...ROLES.slice(1), { key: '', label: ' Archer ', emoji: '🏹', max: 4 }];
  const r = await request(save(1, { settings: { AUTO_EVENT_SCHEDULE: '9:00', AUTO_EVENT_TITLE: ' Raid ' }, roles, days: { ...allDays(), friday: false } }));
  assert.equal(r.ok, true);
  assert.equal(r.values.AUTO_EVENT_SCHEDULE, '09:00');
  assert.equal(r.values.AUTO_EVENT_TITLE, 'Raid');
  assert.deepEqual(r.roles.map((x) => x.key), ['def-team', 'commander', 'shai', 'flex', 'archer']);
  assert.equal(r.roles[4].label, 'Archer');
  assert.equal(r.days.friday, false);
  assert.equal(schedule.days.friday, false);
  assert.match(r.message, /Mon/);
  assert.deepEqual(r.warnings, []);
  assert.ok(!ui.sent.some((m) => m.type === 'settings'), 'own save is answered, not pushed');
});

test('saving on a standby warns that the leader schedule wins', async () => {
  const { request } = setup({ role: 'standby' });
  const r = await request(save(1));
  assert.equal(r.ok, true);
  assert.match(r.warnings.join(' '), /standby/);
});

test('a schedule change from elsewhere is pushed to the window', async () => {
  const { ui, schedule } = setup();
  ui.sent = [];
  schedule.roles = schedule.roles.slice(0, 2);
  schedule.emit('change');
  assert.equal(ui.sent.length, 1);
  assert.equal(ui.sent[0].type, 'settings');
  assert.equal(ui.sent[0].roles.length, 2);
});

test('lite edition: no settings for the UI, and saving is refused', async () => {
  const { c, ui, store, request } = setup({ edition: 'lite' });
  assert.equal(c.initPayload({}).edition, 'lite');
  await c.handle({ type: 'ready' });
  assert.deepEqual(ui.sent.map((m) => m.type), ['status']);
  const r = await request(save(1, { settings: { AUTO_EVENT_TITLE: 'Nope' } }));
  assert.equal(r.ok, false);
  assert.match(r.error, /full version/);
  assert.equal(store.getEffective().AUTO_EVENT_TITLE, schema.DEFAULTS.AUTO_EVENT_TITLE);
});

test('create event now posts on the leader', async () => {
  const { autoEvent, request } = setup({ role: 'leader' });
  const r = await request({ type: 'createEventNow', id: 1 });
  assert.equal(r.ok, true);
  assert.match(r.message, /Guild Raid Signup/);
  assert.equal(autoEvent.posts, 1);
});

test('create event now is refused on a standby, with hosting off, and in lite', async () => {
  for (const opts of [{ role: 'standby' }, { role: 'off' }, { role: 'leader', edition: 'lite' }]) {
    const { autoEvent, request } = setup(opts);
    const r = await request({ type: 'createEventNow', id: 1 });
    assert.equal(r.ok, false, JSON.stringify(opts));
    assert.match(r.error, opts.edition ? /full version/ : /leader PC/);
    assert.equal(autoEvent.posts, 0);
  }
});

test('a failed manual post is reported, redacted', async () => {
  process.env.DISCORD_BOT_TOKEN = 'super-secret-token';
  try {
    const { request } = setup({ role: 'leader', createNow: async () => { throw new Error('boom super-secret-token'); } });
    const r = await request({ type: 'createEventNow', id: 1 });
    assert.equal(r.ok, false);
    assert.match(r.error, /not posted: boom/);
    assert.ok(!r.error.includes('super-secret-token'));
  } finally {
    delete process.env.DISCORD_BOT_TOKEN;
  }
});

test('visibility, exit and end-session messages are routed', async () => {
  const { c, monitor, exits } = setup();
  await c.handle({ type: 'visibility', visible: true });
  assert.equal(monitor.visible, true);
  await c.handle({ type: 'exit' });
  await c.handle({ type: 'endSession' });
  assert.deepEqual(exits, ['tray', 'endSession']);
});
