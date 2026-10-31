const EventEmitter = require('events');
const { EmbedBuilder } = require('discord.js');
const config = require('../config');
const scheduleConfig = require('./scheduleConfig');
const { blankEvent, createEvent, deleteEvent } = require('../state/eventStore');
const { buildEventEmbed } = require('../logic/messageBuilder');
const { describeDiscordError } = require('../utils/discordErrors');

// Sunday=0 … Saturday=6 (matches Date.getDay())
const DAYS_BY_INDEX = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const PRE_TRANSITION_MS = 60_000; // 1 minute before schedule

const createdSlots = new Set();
let currentAutoEventMsgId = null;
let currentCountdownMsg = null;
let currentTimer = null;
let currentPreTimer = null;
let _client = null; // set by startAutoEvent, cleared by stopAutoEvent

// What the scheduler will do next, for the desktop UI. Emits 'change'.
//   { state: 'scheduled', at, dayName, time } | { state: 'idle', reason }
const status = new EventEmitter();
const IDLE_NOT_RUNNING = 'Not running on this PC.';
let _status = { state: 'idle', reason: IDLE_NOT_RUNNING };
function setStatus(next) {
  _status = next;
  status.emit('change', getStatus());
}
function getStatus() {
  return { ..._status };
}

// Identifies one scheduled run in *local* time (the schedule is local). Keying
// on the UTC date wrongly skipped a second run that shared a UTC date — e.g.
// after the user moved today's time later to retry.
function slotKey(at, time) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${time}`;
}

// Find the next enabled day+time from now. Returns { ms, dayName, time, pools } or null.
function msUntilNextEnabled() {
  const now = new Date();
  const todayIdx = now.getDay();
  const sched = scheduleConfig.get();

  for (let offset = 0; offset < 7; offset++) {
    const dayIdx = (todayIdx + offset) % 7;
    const dayName = DAYS_BY_INDEX[dayIdx];
    const dayCfg = sched[dayName];
    if (!dayCfg || !dayCfg.enabled) continue;

    const [hour, minute] = dayCfg.time.split(':').map(Number);
    const next = new Date(now);
    next.setDate(now.getDate() + offset);
    next.setHours(hour, minute, 0, 0);
    if (next > now) {
      return { ms: next - now, at: next, dayName, time: dayCfg.time, pools: dayCfg.pools };
    }
  }
  return null; // all days disabled
}

async function clearChannel(channel) {
  const messages = await channel.messages.fetch({ limit: 100 });
  if (messages.size === 0) return;

  if (messages.size === 1) {
    await messages.first().delete().catch(() => {});
    return;
  }

  await channel.bulkDelete(messages).catch(async () => {
    for (const msg of messages.values()) {
      await msg.delete().catch(() => {});
    }
  });
}

async function preTransition(client, msUntilEvent) {
  if (currentAutoEventMsgId) {
    deleteEvent(currentAutoEventMsgId);
    currentAutoEventMsgId = null;
  }

  let channel;
  try {
    channel = await client.channels.fetch(config.autoEvent.channelId);
  } catch (err) {
    console.error('[AutoEvent] Pre-transition failed to fetch channel:', err.message);
    return;
  }

  try {
    await clearChannel(channel);
  } catch (err) {
    console.error('[AutoEvent] Pre-transition failed to clear channel:', err.message);
  }

  const eventUnixTs = Math.floor((Date.now() + msUntilEvent) / 1000);

  const countdownEmbed = new EmbedBuilder()
    .setTitle('⏳ Next Event Starting Soon')
    .setDescription(`A new event will begin <t:${eventUnixTs}:R>.`)
    .setColor(0x808080)
    .setFooter({ text: 'Signups are closed. Please wait for the new card.' });

  try {
    currentCountdownMsg = await channel.send({ embeds: [countdownEmbed] });
    console.log('[AutoEvent] Pre-transition: cleared channel, posted countdown.');
  } catch (err) {
    console.error('[AutoEvent] Pre-transition failed to send countdown:', err.message);
  }
}

async function fetchEventChannel(client) {
  try {
    return await client.channels.fetch(config.autoEvent.channelId);
  } catch (err) {
    throw new Error(`Could not open the event channel: ${describeDiscordError(err)}`);
  }
}

// Posts a signup card with the current roles and the given per-role limits.
// Throws on failure. Returns false if hosting stopped while posting.
async function postEvent(client, channel, pools) {
  const { autoEvent } = config;
  // Snapshot the roles so this card keeps working if they change later.
  const roles = scheduleConfig.getRoles();
  const poolLimits = {};
  for (const r of roles) poolLimits[r.key] = (pools && pools[r.key]) || r.max;
  const fields = {
    title: autoEvent.title,
    description: autoEvent.description,
    roles,
    poolLimits,
    donkeyEmoji: config.donkeyEmoji,
  };

  let message;
  try {
    message = await channel.send({ embeds: [buildEventEmbed(blankEvent(fields))] });
  } catch (err) {
    throw new Error(`Could not post the event card: ${describeDiscordError(err)}`);
  }
  // Hosting was turned off while the card was being posted.
  if (_client !== client) return false;

  createEvent(message.id, channel.id, channel.guildId, fields);

  for (const role of roles) {
    await message.react(role.emoji);
  }

  if (currentCountdownMsg) {
    await currentCountdownMsg.delete().catch(() => {});
    currentCountdownMsg = null;
  }

  currentAutoEventMsgId = message.id;
  return true;
}

async function runAutoEvent(client, pools, slot) {
  const { autoEvent } = config;
  if (!autoEvent.enabled || !autoEvent.channelId || !autoEvent.title) return;

  if (createdSlots.has(slot)) {
    console.log(`[AutoEvent] Already created for ${slot}, skipping duplicate.`);
    return;
  }

  const channel = await fetchEventChannel(client);
  if (!(await postEvent(client, channel, pools))) return;
  createdSlots.add(slot);
  console.log(`[AutoEvent] Created event "${autoEvent.title}" for ${slot}`);
}

// "Create event now" from the desktop UI, for when the automatic event didn't
// post. Same as an automatic run (clear the channel, post with today's limits)
// but it leaves the schedule alone: today's automatic event still runs.
let manualBusy = false;
async function createNow() {
  if (!_client) {
    if (_status.state === 'idle' && _status.reason !== IDLE_NOT_RUNNING) throw new Error(_status.reason);
    throw new Error('Only the leader PC can post events.');
  }
  if (manualBusy) throw new Error('Already posting an event.');
  manualBusy = true;
  const client = _client;
  try {
    const channel = await fetchEventChannel(client);
    if (currentAutoEventMsgId) {
      deleteEvent(currentAutoEventMsgId);
      currentAutoEventMsgId = null;
    }
    await clearChannel(channel).catch((err) =>
      console.warn('[AutoEvent] Manual post: could not clear the channel:', err.message));
    currentCountdownMsg = null; // removed with the channel contents

    const today = DAYS_BY_INDEX[new Date().getDay()];
    const day = scheduleConfig.get(today);
    if (!(await postEvent(client, channel, day && day.pools))) {
      throw new Error('Hosting stopped while the event was being posted.');
    }
    const { title } = config.autoEvent;
    console.log(`[AutoEvent] Created event "${title}" manually from the desktop UI.`);
    // Standbys pick up the new card's state right away.
    const coordinator = require('../ha/coordinator');
    if (coordinator.isLeader) {
      coordinator.broadcastNow().catch((err) => console.warn('[AutoEvent] Broadcast after manual post failed:', err.message));
    }
    return { title };
  } finally {
    manualBusy = false;
  }
}

function scheduleTick() {
  const result = msUntilNextEnabled();

  if (!result) {
    console.log('[AutoEvent] No weekdays selected — checking again in 1 hour.');
    setStatus({ state: 'idle', reason: 'No weekdays are selected for automatic events.' });
    currentTimer = setTimeout(scheduleTick, 60 * 60 * 1000);
    return;
  }

  const { ms: delay, at, dayName, time, pools } = result;
  setStatus({ state: 'scheduled', at: at.getTime(), dayName, time });
  const minutesUntil = Math.round(delay / 60000);
  console.log(`[AutoEvent] Next auto-event in ${minutesUntil}m on ${dayName} at ${time}`);

  if (delay > PRE_TRANSITION_MS) {
    currentPreTimer = setTimeout(async () => {
      if (_client) await preTransition(_client, PRE_TRANSITION_MS);
    }, delay - PRE_TRANSITION_MS);
  }

  currentTimer = setTimeout(async () => {
    if (!_client) return;
    try {
      await runAutoEvent(_client, pools, slotKey(at, time));
    } catch (err) {
      console.error('[AutoEvent] Failed to create event:', err.message);
    }
    if (_client) scheduleTick();
  }, delay);
}

function clearTimers() {
  if (currentTimer) clearTimeout(currentTimer);
  if (currentPreTimer) clearTimeout(currentPreTimer);
  currentTimer = null;
  currentPreTimer = null;
}

// Re-plan the next run whenever the per-day schedule changes, so future events
// always use the newest time and pool limits.
function onScheduleChange() {
  if (!_client) return;
  clearTimers();
  console.log('[AutoEvent] Schedule updated — restarting scheduler.');
  scheduleTick();
}

function startAutoEvent(client) {
  if (!config.autoEvent.enabled) {
    console.log('[AutoEvent] Scheduler not started: AUTO_EVENT_ENABLED is not set to true');
    setStatus({ state: 'idle', reason: 'Automatic events are disabled in this build (AUTO_EVENT_ENABLED).' });
    return;
  }
  if (!config.autoEvent.channelId) {
    console.log('[AutoEvent] Scheduler not started: AUTO_EVENT_CHANNEL_ID is missing');
    setStatus({ state: 'idle', reason: 'No event channel in this build (AUTO_EVENT_CHANNEL_ID).' });
    return;
  }
  if (!config.autoEvent.title) {
    console.log('[AutoEvent] Scheduler not started: AUTO_EVENT_TITLE is missing');
    setStatus({ state: 'idle', reason: 'No event title is set.' });
    return;
  }

  stopAutoEvent();
  _client = client;
  scheduleConfig.on('change', onScheduleChange);
  scheduleTick();
}

// Called when hosting turns OFF or this node loses leadership.
function stopAutoEvent() {
  scheduleConfig.off('change', onScheduleChange);
  clearTimers();
  _client = null;
  currentCountdownMsg = null;
  setStatus({ state: 'idle', reason: IDLE_NOT_RUNNING });
}

module.exports = { startAutoEvent, stopAutoEvent, createNow, getStatus, status, slotKey };
