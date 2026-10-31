const test = require('node:test');
const assert = require('node:assert/strict');
const { summarizeNodes } = require('../src/ha/nodeStatus');
const { NodeMonitor } = require('../src/desktop/nodeMonitor');
const { buildStatusView } = require('../src/desktop/statusView');

const NOW = Date.parse('2026-10-30T12:00:00Z');
const ago = (min) => new Date(NOW - min * 60000).toISOString();
const bot = { bot: true };

const stateMsg = (min, content = '🟢 **Leader:** `node-1-0001`') =>
  ({ author: bot, content, timestamp: ago(min), edited_timestamp: null, attachments: [{ filename: 'state.json' }] });
const presence = (min, role = 'standby') =>
  ({ author: bot, content: `[NODE] \`node-2\` | **${role}** | <t:1:R>`, timestamp: ago(60), edited_timestamp: ago(min), attachments: [] });

test('counts an active leader and fresh standbys; old heartbeats are stale', () => {
  const s = summarizeNodes([stateMsg(3), presence(5), presence(12), presence(25)], NOW);
  assert.equal(s.leader.id, 'node-1-0001');
  assert.equal(s.leader.active, true);
  assert.equal(s.activeCount, 3);
  assert.equal(s.standbyStale, 1);
  assert.equal(s.staleCount, 1);
});

test('ignores status cards, offline cards, human messages and non-presence bot text', () => {
  const s = summarizeNodes([
    { author: bot, content: '⚠️ **No active host** — starting…', timestamp: ago(1), attachments: [] },
    { author: bot, content: '🔴 **No active node** — host shut down', timestamp: ago(1), attachments: [] },
    { author: { bot: false }, content: '[NODE] `fake` | **standby** |', timestamp: ago(1), attachments: [] },
  ], NOW);
  assert.equal(s.leader, null);
  assert.equal(s.activeCount, 0);
  assert.equal(s.staleCount, 0);
});

test('a leader that stopped syncing is stale, not active', () => {
  const s = summarizeNodes([stateMsg(30)], NOW);
  assert.equal(s.activeCount, 0);
  assert.equal(s.staleCount, 1);
});

test('monitor reports unavailable with last known data on errors', async () => {
  let fail = false;
  const m = new NodeMonitor({
    isConfigured: () => true,
    now: () => NOW,
    fetchMessages: async () => {
      if (fail) throw Object.assign(new Error('nope'), { status: 403 });
      return [stateMsg(1)];
    },
  });
  await m.refresh();
  assert.equal(m.snapshot.available, true);
  fail = true;
  await m.refresh();
  assert.equal(m.snapshot.available, false);
  assert.match(m.snapshot.reason, /cannot read/);
  assert.equal(m.snapshot.summary.activeCount, 1, 'keeps the last good summary');
  assert.equal(m.snapshot.lastSuccessAt, NOW);
});

test('monitor works with no coordination channel', async () => {
  const m = new NodeMonitor({ isConfigured: () => false, fetchMessages: async () => { throw new Error('must not fetch'); } });
  await m.refresh();
  assert.equal(m.snapshot.available, false);
  assert.match(m.snapshot.reason, /No coordination channel/);
});

const connection = { ok: true, missing: [], hasCoordinationChannel: true, hasEventChannel: true, autoEventEnabled: true };

test('status view: hosting OFF still shows live node monitoring', () => {
  const v = buildStatusView({
    hosting: { state: 'stopped', role: 'off', detail: '', error: null },
    hostingEnabled: false,
    connection,
    monitor: { available: true, summary: summarizeNodes([stateMsg(2), presence(1)], NOW), lastSuccessAt: NOW, checkedAt: NOW },
    now: NOW,
  });
  assert.equal(v.hosting.label, 'OFF');
  assert.equal(v.hosting.roleLabel, 'Off');
  assert.equal(v.hosting.canToggle, true);
  assert.equal(v.nodes.count, '2');
  assert.equal(v.nodes.level, 'ok');
  assert.ok(!/includes this PC/.test(v.nodes.detail));
  assert.deepEqual(v.notices, []);
});

test('status view: leader role, stale data and unavailable states', () => {
  const leader = buildStatusView({
    hosting: { state: 'running', role: 'leader', detail: 'Hosting as Bot#1.', error: null },
    hostingEnabled: true,
    connection,
    monitor: { available: true, summary: summarizeNodes([stateMsg(2)], NOW), lastSuccessAt: NOW - 10 * 60000, checkedAt: NOW },
    now: NOW,
  });
  assert.equal(leader.hosting.roleLabel, 'Leader');
  assert.equal(leader.nodes.level, 'stale', 'old data is flagged');
  assert.match(leader.nodes.detail, /includes this PC/);
  assert.match(leader.tooltip, /Hosting ON \(Leader\)/);
  assert.ok(leader.tooltip.length <= 63);

  const down = buildStatusView({
    hosting: { state: 'stopped', role: 'off', detail: '', error: null },
    hostingEnabled: false,
    connection: { ...connection, ok: false, missing: ['DISCORD_BOT_TOKEN'] },
    monitor: { available: false, reason: 'Discord is unreachable (ENOTFOUND).', summary: null, lastSuccessAt: null },
    now: NOW,
  });
  assert.equal(down.nodes.level, 'unavailable');
  assert.equal(down.nodes.count, '—');
  assert.equal(down.hosting.canToggle, false, 'cannot turn ON without a connection');
  assert.ok(down.notices.some((n) => /DISCORD_BOT_TOKEN missing/.test(n)));
});

test('after a 401 the cleared-token error still reads as a rejected token', () => {
  const { describeDiscordError } = require('../src/utils/discordErrors');
  assert.equal(describeDiscordError(new Error('Expected token to be set for this request, but none was present')), 'Discord rejected the bot token.');
  assert.equal(describeDiscordError(Object.assign(new Error('x'), { status: 401 })), 'Discord rejected the bot token.');
  assert.match(describeDiscordError(Object.assign(new Error('x'), { code: 'ENOTFOUND' })), /unreachable \(ENOTFOUND\)/);
});

test('status view: role badge and next event for leader, standby and off', () => {
  const at = new Date(2026, 9, 31, 0, 23).getTime(); // Sat 31 Oct 00:23 local
  const base = { hostingEnabled: true, connection, monitor: { loading: true } };
  const leader = buildStatusView({ ...base, hosting: { state: 'running', role: 'leader', detail: '', error: null },
    autoEvent: { state: 'scheduled', at, dayName: 'saturday', time: '00:23' }, now: at - (21 * 60 + 50) * 60000 });
  assert.equal(leader.hosting.roleLevel, 'leader');
  assert.match(leader.hosting.roleExplain, /posts the events/);
  assert.equal(leader.hosting.nextEvent, 'Sat 31 Oct, 00:23 (in 21 h 50 min)');
  assert.equal(leader.hosting.canCreateEvent, true);
  assert.equal(leader.hosting.createEventHint, '');

  const idle = buildStatusView({ ...base, hosting: { state: 'running', role: 'leader', detail: '', error: null },
    autoEvent: { state: 'idle', reason: 'Automatic events are disabled in this build (AUTO_EVENT_ENABLED).' }, now: at });
  assert.match(idle.hosting.nextEvent, /disabled in this build/);

  const standby = buildStatusView({ ...base, hosting: { state: 'running', role: 'standby', detail: '', error: null }, autoEvent: null, now: at });
  assert.equal(standby.hosting.roleLevel, 'standby');
  assert.match(standby.hosting.nextEvent, /leader PC/);
  assert.equal(standby.hosting.canCreateEvent, false);
  assert.match(standby.hosting.createEventHint, /leader PC/);

  const off = buildStatusView({ ...base, hostingEnabled: false, hosting: { state: 'stopped', role: 'off', detail: '', error: null }, autoEvent: null, now: at });
  assert.equal(off.hosting.roleLevel, 'off');
  assert.equal(off.hosting.canCreateEvent, false);
});

test('auto-event duplicate guard is keyed by local date and time, not UTC date', () => {
  const { slotKey } = require('../src/scheduler/autoEvent');
  const evening = new Date(2026, 9, 30, 21, 30);
  const later = new Date(2026, 9, 30, 22, 0);
  assert.equal(slotKey(evening, '21:30'), '2026-10-30 21:30');
  assert.notEqual(slotKey(evening, '21:30'), slotKey(later, '22:00'), 'moving today\'s time later is a new slot');
});
