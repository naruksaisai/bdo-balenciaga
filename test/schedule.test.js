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
const { assignUser } = require('../src/logic/poolLogic');
const { buildEventEmbed } = require('../src/logic/messageBuilder');
const schema = require('../src/settings/schema');

const file = path.join(dir, 'schedule.json');
const ROLES = schema.resolveLegacyRoles({});
const pools = (o = {}) => ({ mainball: 20, 'def-team': 10, commander: 2, shai: 3, flex: 5, ...o });
const allDays = (v = true) => Object.fromEntries(scheduleConfig.DAYS.map((d) => [d, v]));

function seed({ roles = ROLES } = {}) {
  const s = {};
  for (const d of scheduleConfig.DAYS) s[d] = { enabled: true, time: '21:30', pools: pools() };
  s.friday = { enabled: false, time: '19:00', pools: pools({ shai: 6 }) }; // customized day
  if (roles) s.roles = roles;
  fs.writeFileSync(file, JSON.stringify(s));
  scheduleConfig.init(file);
}

function leader() {
  const coordinator = { isLeader: true, broadcasts: 0, broadcastNow: () => { coordinator.broadcasts++; return Promise.resolve(); } };
  return coordinator;
}

test('loading repairs invalid fields without losing valid customizations', () => {
  fs.writeFileSync(file, JSON.stringify({ monday: { enabled: false, time: '99:99', pools: { shai: 4, flex: -1 } } }));
  scheduleConfig.init(file);
  const m = scheduleConfig.get('monday');
  assert.equal(m.enabled, false);
  assert.equal(m.pools.shai, 4);
  // Defaults come from the effective config (which may include a local .env).
  const { autoEvent } = require('../src/config');
  const seeded = require('../src/settings/settingsStore').getLegacyRoles();
  assert.equal(m.time, autoEvent.schedule);
  assert.equal(m.pools.flex, seeded.find((r) => r.key === 'flex').max);
  assert.ok(scheduleConfig.get('sunday'), 'missing days are filled in');
});

test('a schedule from an older version gains the built-in roles and keeps its per-day limits', () => {
  seed({ roles: null });
  assert.deepEqual(scheduleConfig.getRoles().map((r) => r.key), ['mainball', 'def-team', 'commander', 'shai', 'flex']);
  assert.equal(scheduleConfig.get('friday').pools.shai, 6);
  assert.ok(Array.isArray(JSON.parse(fs.readFileSync(file, 'utf8')).roles), 'role list persisted');
});

test('broken roles are dropped one by one', () => {
  seed({ roles: [...ROLES, { key: 'bad', label: '', emoji: '🏹', max: 3 }, { key: 'dup', label: 'Dup', emoji: ROLES[0].emoji, max: 3 }] });
  assert.equal(scheduleConfig.getRoles().length, 5);
  assert.equal(scheduleConfig.get('monday').pools.bad, undefined);
});

test('weekday selection and role edits update every day in one change', () => {
  seed();
  let changes = 0;
  const onChange = () => changes++;
  scheduleConfig.on('change', onChange);
  const roles = [
    ...ROLES.filter((r) => r.key !== 'commander').map((r) => (r.key === 'shai' ? { ...r, max: 4 } : r)),
    { key: 'archer', label: 'Archer', emoji: '🏹', max: 7 },
  ];
  const changed = scheduleConfig.setRolesAndDays(roles, { ...allDays(), monday: false, friday: true });
  scheduleConfig.off('change', onChange);

  assert.equal(changes, 1, 'one change event for the whole update');
  assert.deepEqual(scheduleConfig.getEnabledDays(), { ...allDays(), monday: false });
  const mon = scheduleConfig.get('monday');
  assert.equal(mon.pools.archer, 7, 'new role starts at its max');
  assert.equal(mon.pools.commander, undefined, 'removed role is dropped');
  assert.equal(mon.pools.shai, 4, 'day on the old max follows the new one');
  assert.equal(scheduleConfig.get('friday').pools.shai, 6, 'customized day keeps its value');
  assert.ok(changed.includes('monday') && changed.includes('friday'));
  assert.deepEqual(scheduleConfig.getRoles().map((r) => r.key), ['mainball', 'def-team', 'shai', 'flex', 'archer']);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).roles.length, 5, 'persisted');
});

test('saving the same roles and days changes nothing', () => {
  seed();
  let changes = 0;
  const onChange = () => changes++;
  scheduleConfig.on('change', onChange);
  const changed = scheduleConfig.setRolesAndDays(ROLES, scheduleConfig.getEnabledDays());
  scheduleConfig.off('change', onChange);
  assert.deepEqual(changed, []);
  assert.equal(changes, 0);
});

test('default time changes only move days still on the old default', () => {
  seed();
  const changed = scheduleConfig.applyDefaultsChange({ time: '21:30' }, { time: '20:00' });
  assert.ok(!changed.includes('friday'));
  assert.equal(scheduleConfig.get('monday').time, '20:00');
  assert.equal(scheduleConfig.get('friday').time, '19:00');
});

test('a leader broadcast without roles keeps the local role list', () => {
  seed();
  scheduleConfig.setRolesAndDays([...ROLES, { key: 'archer', label: 'Archer', emoji: '🏹', max: 7 }], allDays());
  const old = {};
  for (const d of scheduleConfig.DAYS) old[d] = { enabled: true, time: '18:00', pools: pools() };
  scheduleConfig.applyFull(old);
  assert.equal(scheduleConfig.getRoles().length, 6);
  assert.equal(scheduleConfig.get('monday').time, '18:00');
  assert.equal(scheduleConfig.get('monday').pools.archer, 7);

  scheduleConfig.applyFull({ ...old, roles: ROLES.slice(0, 2) });
  assert.deepEqual(scheduleConfig.getRoles().map((r) => r.key), ['mainball', 'def-team'], "the leader's roles win");
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

test('update validates time strictly and pools against the role list', () => {
  seed();
  assert.throws(() => scheduleConfig.update('monday', { time: '24:00' }), /Invalid time/);
  assert.throws(() => scheduleConfig.update('monday', { pools: { archer: 3 } }), /Unknown role/);
  scheduleConfig.update('monday', { time: '7:15' });
  assert.equal(scheduleConfig.get('monday').time, '07:15');
});

test('settings change saves roles, pins old emojis on legacy events and broadcasts', () => {
  seed();
  eventStore.importState({ legacy: { messageId: 'legacy', poolLimits: pools(), participants: {}, pools: {} } });
  const prev = { ...schema.DEFAULTS };
  const roles = ROLES.map((r) => (r.key === 'mainball' ? { ...r, emoji: '🏹' } : r));
  const coordinator = leader();
  const r = applySettingsChange({ prev, next: prev, roles, days: allDays() }, { scheduleConfig, eventStore, coordinator });

  const legacy = eventStore.getEvent('legacy');
  assert.equal(legacy.emojis.mainball, '⚔️');
  assert.equal(getPoolFromEmoji({ id: null, name: '⚔️' }, legacy), 'mainball');
  assert.equal(scheduleConfig.getRoles()[0].emoji, '🏹');
  assert.deepEqual(r.changedDays, [], 'an emoji change moves no per-day limits');
  assert.equal(scheduleConfig.get('friday').enabled, true, 'friday was re-enabled');
  assert.equal(coordinator.broadcasts, 1, 'leader pushes the change to standbys');
});

test('an event posted with an added role renders it and maps its reactions', () => {
  const roles = [{ key: 'mainball', label: 'Mainball', emoji: '⚔️' }, { key: 'archer', label: 'Archer', emoji: '<:bow:123456789012345678>' }];
  eventStore.createEvent('m1', 'c', 'g', { title: 'Raid', description: '', roles, poolLimits: { mainball: 20, archer: 1 }, donkeyEmoji: '🐴' });
  const event = eventStore.getEvent('m1');

  assert.equal(getPoolFromEmoji({ id: '123456789012345678', name: 'bow' }, event), 'archer');
  assert.equal(getPoolFromEmoji({ id: null, name: '🛡️' }, event), null, 'roles not on the card are ignored');
  assignUser(event, 'u1', 'Alice', 'archer');
  assignUser(event, 'u2', 'Bob', 'archer'); // full → overflow
  assignUser(event, 'u3', 'Eve', 'shai');   // not a role of this event

  const fields = buildEventEmbed(event).toJSON().fields.map((f) => f.name);
  assert.deepEqual(fields, ['👥 Total Participants', '⚔️ Mainball (0/20)', '<:bow:123456789012345678> Archer (1/1)', '🐴 Donkey (Overflow) (1)']);
  assert.match(buildEventEmbed(event).toJSON().fields[3].value, /Bob \(Archer\)/);
  assert.equal(event.participants.u3, undefined);
});

test('an event from before roles were editable still renders the built-ins', () => {
  const legacy = { title: 'Old', description: '', poolLimits: pools(), participants: {}, emojis: { mainball: '🔥' },
    pools: { mainball: [], 'def-team': [], commander: [], shai: [], flex: [], donkey: [] } };
  const names = buildEventEmbed(legacy).toJSON().fields.map((f) => f.name);
  assert.equal(names.length, 6);
  assert.equal(names[1], '🔥 Mainball (0/20)');
  assert.equal(getPoolFromEmoji({ id: null, name: '🔥' }, legacy), 'mainball');
});
