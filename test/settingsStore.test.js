const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { useTempDataDir } = require('./helpers');

const dir = useTempDataDir();
const { SettingsStore } = require('../src/settings/settingsStore');
const schema = require('../src/settings/schema');

let n = 0;
const freshFile = () => path.join(dir, `settings-${++n}.json`);

test('first launch: hosting OFF, file created, valid legacy settings adopted', () => {
  const file = freshFile();
  const store = new SettingsStore(file).load({ legacySettings: { AUTO_EVENT_TITLE: 'Old title', AUTO_EVENT_FLEX_MAX: 'nope' } });
  assert.equal(store.firstLaunch, true);
  assert.equal(store.isHostingEnabled(), false);
  assert.equal(store.getEffective().AUTO_EVENT_TITLE, 'Old title');
  assert.ok(store.loadWarnings.some((w) => /AUTO_EVENT_FLEX_MAX/.test(w)));
  assert.ok(fs.existsSync(file));
});

test('hosting choice persists across loads', () => {
  const file = freshFile();
  new SettingsStore(file).load().setHostingEnabled(true);
  const again = new SettingsStore(file).load();
  assert.equal(again.firstLaunch, false);
  assert.equal(again.isHostingEnabled(), true);
});

test('save validates, persists and returns prev/next', () => {
  const file = freshFile();
  const store = new SettingsStore(file).load();
  const bad = store.save({ ...schema.DEFAULTS, AUTO_EVENT_SCHEDULE: 'later' });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.AUTO_EVENT_SCHEDULE);

  const r = store.save({ ...schema.DEFAULTS, AUTO_EVENT_TITLE: 'New', AUTO_EVENT_SCHEDULE: '8:00' });
  assert.equal(r.ok, true);
  assert.equal(r.prev.AUTO_EVENT_TITLE, schema.DEFAULTS.AUTO_EVENT_TITLE);
  assert.equal(r.value.AUTO_EVENT_SCHEDULE, '08:00');
  assert.equal(new SettingsStore(file).load().getEffective().AUTO_EVENT_TITLE, 'New');
});

test('a failed write leaves the running settings unchanged', () => {
  const file = freshFile();
  const store = new SettingsStore(file).load();
  store._write = () => { throw new Error('disk full'); };
  const r = store.save({ ...schema.DEFAULTS, AUTO_EVENT_TITLE: 'Never' });
  assert.equal(r.ok, false);
  assert.match(r.error, /disk full/);
  assert.equal(store.getEffective().AUTO_EVENT_TITLE, schema.DEFAULTS.AUTO_EVENT_TITLE);
});

test('corrupt settings file is kept aside and defaults are used', () => {
  const file = freshFile();
  fs.writeFileSync(file, '{ not json');
  const store = new SettingsStore(file).load();
  assert.equal(store.isHostingEnabled(), false);
  assert.ok(store.loadWarnings.some((w) => /moved/.test(w)));
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith(path.basename(file) + '.corrupt-')));
});

test('saved values win over environment values', () => {
  const file = freshFile();
  process.env.AUTO_EVENT_TITLE = 'From env';
  try {
    const store = new SettingsStore(file).load();
    assert.equal(store.getEffective().AUTO_EVENT_TITLE, 'From env');
    store.save({ ...schema.DEFAULTS, AUTO_EVENT_TITLE: 'From UI' });
    assert.equal(store.getEffective().AUTO_EVENT_TITLE, 'From UI');
  } finally {
    delete process.env.AUTO_EVENT_TITLE;
  }
});
