const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { useTempDataDir } = require('./helpers');

const dir = useTempDataDir();
const scheduleConfig = require('../src/scheduler/scheduleConfig');
const eventStore = require('../src/state/eventStore');
const { applySettingsChange } = require('../src/settings/effects');
const { getPoolFromEmoji } = require('../src/utils/emojiMap');
const schema = require('../src/settings/schema');

const file = path.join(dir, 'schedule.json');
const pools = (o = {}) => ({ mainball: 20, 'def-team': 10, commander: 2, shai: 3, flex: 5, ...o });

function seed() {
  const s = {};
  for (const d of scheduleConfig.DAYS) s[d] = { enabled: true, time: '21:30', pools: pools() };
  s.friday = { enabled: false, time: '19:00', pools: pools({ shai: 6 }) }; // customized day
  fs.writeFileSync(file, JSON.stringify(s));
  scheduleConfig.init(file);
}

test('loading repairs invalid fields without losing valid customizations', () => {
  fs.writeFileSync(file, JSON.stringify({ monday: { enabled: false, time: '99:99', pools: { shai: 4, flex: -1 } } }));
  scheduleConfig.init(file);
  const m = scheduleConfig.get('monday');
  assert.equal(m.enabled, false);
  assert.equal(m.pools.shai, 4);
  // Defaults come from the effective config (which may include a local .env).
  const { autoEvent } = require('../src/config');
  assert.equal(m.time, autoEvent.schedule);
  assert.equal(m.pools.flex, autoEvent.poolLimits.flex);
  assert.ok(scheduleConfig.get('sunday'), 'missing days are filled in');
});

test('default changes only move days still on the old default', () => {
  seed();
  let changes = 0;
  const onChange = () => changes++;
  scheduleConfig.on('change', onChange);
  const changed = scheduleConfig.applyDefaultsChange(
    { time: '21:30', pools: pools() },
    { time: '20:00', pools: pools({ shai: 4 }) },
  );
  scheduleConfig.off('change', onChange);

  assert.equal(changes, 1, 'one change event for the whole update');
  assert.ok(!changed.includes('friday'));
  assert.equal(scheduleConfig.get('monday').time, '20:00');
  assert.equal(scheduleConfig.get('monday').pools.shai, 4);
  assert.deepEqual(scheduleConfig.get('friday'), { enabled: false, time: '19:00', pools: pools({ shai: 6 }) });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).monday.time, '20:00', 'persisted');
});

test('a failed schedule write keeps the in-memory schedule', () => {
  seed();
  fs.rmSync(file);
  fs.mkdirSync(file); // a directory where the file should be → rename fails
  try {
    assert.throws(() => scheduleConfig.update('monday', { time: '10:00' }));
    assert.equal(scheduleConfig.get('monday').time, '21:30');
  } finally {
    fs.rmSync(file, { recursive: true });
  }
});

test('update validates time strictly', () => {
  seed();
  assert.throws(() => scheduleConfig.update('monday', { time: '24:00' }), /Invalid time/);
  scheduleConfig.update('monday', { time: '7:15' });
  assert.equal(scheduleConfig.get('monday').time, '07:15');
});

test('settings change pins old emojis on existing events so their reactions keep working', () => {
  seed();
  eventStore.importState({ legacy: { messageId: 'legacy', poolLimits: pools(), participants: {}, pools: {} } });
  eventStore.createEvent('new', 'c', 'g', { title: 't', description: '', poolLimits: pools(), emojis: { mainball: '🔥' } });

  const prev = { ...schema.DEFAULTS };
  const next = { ...schema.DEFAULTS, MAINBALL_EMOJI: '🏹' };
  const coordinator = { isLeader: true, broadcastNow: () => { coordinator.broadcasts = (coordinator.broadcasts || 0) + 1; return Promise.resolve(); } };
  applySettingsChange({ prev, next }, { scheduleConfig, eventStore, coordinator });

  const legacy = eventStore.getEvent('legacy');
  assert.equal(legacy.emojis.mainball, '⚔️');
  assert.equal(getPoolFromEmoji({ id: null, name: '⚔️' }, legacy.emojis), 'mainball');
  assert.equal(eventStore.getEvent('new').emojis.mainball, '🔥', 'events with their own emojis are untouched');
  assert.equal(coordinator.broadcasts, 1, 'leader pushes the change to standbys');
});
