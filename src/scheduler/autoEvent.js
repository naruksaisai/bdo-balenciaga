const { EmbedBuilder } = require('discord.js');
const config = require('../config');
const scheduleConfig = require('./scheduleConfig');
const { createEvent, deleteEvent } = require('../state/eventStore');
const { buildEventEmbed } = require('../logic/messageBuilder');

// Sunday=0 … Saturday=6 (matches Date.getDay())
const DAYS_BY_INDEX = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const PRE_TRANSITION_MS = 60_000; // 1 minute before schedule

const createdDates = new Set();
let currentAutoEventMsgId = null;
let currentCountdownMsg = null;
let currentTimer = null;
let currentPreTimer = null;
let _client = null; // set by startAutoEvent, cleared by stopAutoEvent

function todayKey() {
  return new Date().toISOString().slice(0, 10);
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
      return { ms: next - now, dayName, time: dayCfg.time, pools: dayCfg.pools };
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

async function runAutoEvent(client, pools) {
  const { autoEvent } = config;
  if (!autoEvent.enabled || !autoEvent.channelId || !autoEvent.title) return;

  const today = todayKey();
  if (createdDates.has(today)) {
    console.log(`[AutoEvent] Already created for ${today}, skipping duplicate.`);
    return;
  }

  const poolLimits = pools || autoEvent.poolLimits;

  let channel;
  try {
    channel = await client.channels.fetch(autoEvent.channelId);
  } catch {
    console.error(`[AutoEvent] Could not fetch channel ${autoEvent.channelId}`);
    return;
  }

  // Snapshot the emojis so this card keeps working if they change later.
  const emojis = config.emojis;
  const tempEvent = {
    title: autoEvent.title,
    description: autoEvent.description,
    poolLimits,
    emojis,
    pools: { mainball: [], 'def-team': [], commander: [], shai: [], flex: [], donkey: [] },
    participants: {},
  };

  const embed = buildEventEmbed(tempEvent);
  const message = await channel.send({ embeds: [embed] });
  // Hosting was turned off while the card was being posted.
  if (_client !== client) return;

  createEvent(message.id, channel.id, channel.guildId, {
    title: autoEvent.title,
    description: autoEvent.description,
    poolLimits,
    emojis,
  });

  for (const pool of ['mainball', 'def-team', 'commander', 'shai', 'flex']) {
    await message.react(emojis[pool]);
  }

  if (currentCountdownMsg) {
    await currentCountdownMsg.delete().catch(() => {});
    currentCountdownMsg = null;
  }

  currentAutoEventMsgId = message.id;
  createdDates.add(today);
  console.log(`[AutoEvent] Created event "${autoEvent.title}" for ${today}`);
}

function scheduleTick() {
  const result = msUntilNextEnabled();

  if (!result) {
    console.log('[AutoEvent] All days disabled — checking again in 1 hour.');
    currentTimer = setTimeout(scheduleTick, 60 * 60 * 1000);
    return;
  }

  const { ms: delay, dayName, time, pools } = result;
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
      await runAutoEvent(_client, pools);
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
    return;
  }
  if (!config.autoEvent.channelId) {
    console.log('[AutoEvent] Scheduler not started: AUTO_EVENT_CHANNEL_ID is missing');
    return;
  }
  if (!config.autoEvent.title) {
    console.log('[AutoEvent] Scheduler not started: AUTO_EVENT_TITLE is missing');
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
}

module.exports = { startAutoEvent, stopAutoEvent };
