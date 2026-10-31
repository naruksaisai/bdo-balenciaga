const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { useTempDataDir } = require('./helpers');

const dir = useTempDataDir();
process.env.AUTO_EVENT_ENABLED = 'true';
process.env.AUTO_EVENT_CHANNEL_ID = '111111111111111111';
const scheduleConfig = require('../src/scheduler/scheduleConfig');
const autoEvent = require('../src/scheduler/autoEvent');
const eventStore = require('../src/state/eventStore');

scheduleConfig.init(path.join(dir, 'schedule.json'));
const ROLES = [
  { key: 'mainball', label: 'Mainball', emoji: '⚔️', max: 20 },
  { key: 'archer', label: 'Archer', emoji: '🏹', max: 4 },
];
const allDays = Object.fromEntries(scheduleConfig.DAYS.map((d) => [d, true]));
scheduleConfig.setRolesAndDays(ROLES, allDays);

// A Discord client stand-in: one channel that records what the bot does.
function fakeClient() {
  const channel = { id: '111111111111111111', guildId: 'g', posted: [], cleared: 0, nextId: 1 };
  channel.messages = { fetch: async () => { channel.cleared++; return new Map(); } };
  channel.send = async (payload) => {
    const msg = { id: `m${channel.nextId++}`, payload, reactions: [], deleted: false };
    msg.react = async (e) => { msg.reactions.push(e); };
    msg.delete = async () => { msg.deleted = true; };
    channel.posted.push(msg);
    return msg;
  };
  return { channel, channels: { fetch: async () => channel } };
}

test('create event now posts a card with the current roles and today\'s limits', async () => {
  const client = fakeClient();
  const today = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][new Date().getDay()];
  scheduleConfig.update(today, { pools: { archer: 2 } });
  autoEvent.startAutoEvent(client);
  try {
    const before = autoEvent.getStatus();
    const r = await autoEvent.createNow();
    assert.ok(r.title);
    assert.equal(client.channel.cleared, 1, 'channel cleared first');
    assert.equal(client.channel.posted.length, 1);
    const msg = client.channel.posted[0];
    assert.deepEqual(msg.reactions, ['⚔️', '🏹'], 'one reaction per role, in order');
    const event = eventStore.getEvent(msg.id);
    assert.deepEqual(event.poolLimits, { mainball: 20, archer: 2 });
    assert.deepEqual(autoEvent.getStatus(), before, "today's automatic run is untouched");

    await autoEvent.createNow();
    assert.equal(eventStore.getEvent(msg.id), undefined, 'the previous card is replaced');
    assert.ok(eventStore.getEvent(client.channel.posted[1].id));
  } finally {
    autoEvent.stopAutoEvent();
  }
});

test('create event now needs this PC to be running the bot', async () => {
  await assert.rejects(autoEvent.createNow(), /leader PC/);
});

test('a channel that cannot be opened is reported', async () => {
  const client = fakeClient();
  client.channels.fetch = async () => { throw Object.assign(new Error('Missing Access'), { status: 403 }); };
  autoEvent.startAutoEvent(client);
  try {
    await assert.rejects(autoEvent.createNow(), /event channel: The bot lacks permission/);
  } finally {
    autoEvent.stopAutoEvent();
  }
});
