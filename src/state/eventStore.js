const { POOLS } = require('../settings/schema');

// In-memory map: messageId -> eventState
const events = new Map();

// A new, empty event. roles: [{ key, label, emoji }] the card is posted with
// (see settings/roles); poolLimits: { <roleKey>: max }.
function blankEvent({ title, description, roles, poolLimits, donkeyEmoji }) {
  const pools = {};
  const emojis = {};
  for (const r of roles) {
    pools[r.key] = [];
    emojis[r.key] = r.emoji;
  }
  pools.donkey = [];
  emojis.donkey = donkeyEmoji;
  return {
    title,
    description,
    roles: roles.map((r) => ({ key: r.key, label: r.label, emoji: r.emoji })),
    poolLimits: { ...poolLimits },
    // Emojis the card was posted with. Reactions keep mapping to pools even if
    // the configured roles change later.
    emojis,
    // participants: userId -> { userId, username, selectedPool, assignedPool, joinOrder }
    participants: {},
    pools,
    joinSequence: 0,
  };
}

function createEvent(messageId, channelId, guildId, fields) {
  events.set(messageId, { messageId, channelId, guildId, ...blankEvent(fields) });
}

// The roles an event was posted with. Events created before roles were
// editable have the five built-ins; their emojis come from the event, else
// from the current role with the same key, else the built-in default.
function eventRoles(event) {
  if (Array.isArray(event.roles)) return event.roles;
  const current = new Map(require('../scheduler/scheduleConfig').getRoles().map((r) => [r.key, r.emoji]));
  return POOLS.map((p) => ({
    key: p.key,
    label: p.label,
    emoji: (event.emojis && event.emojis[p.key]) || current.get(p.key) || p.defaultEmoji,
  }));
}

function getEvent(messageId) {
  return events.get(messageId);
}

function deleteEvent(messageId) {
  events.delete(messageId);
}

function exportState() {
  const obj = {};
  for (const [id, event] of events) {
    obj[id] = event;
  }
  return obj;
}

function importState(obj) {
  events.clear();
  for (const [id, event] of Object.entries(obj || {})) {
    events.set(id, event);
  }
}

// Events created before emojis were stored per event rely on the configured
// set. Before that set changes, pin the old emojis onto them.
function stampMissingEmojis(emojis) {
  let count = 0;
  for (const event of events.values()) {
    if (!event.emojis) {
      event.emojis = { ...emojis };
      count++;
    }
  }
  return count;
}

module.exports = { blankEvent, createEvent, eventRoles, getEvent, deleteEvent, exportState, importState, stampMissingEmojis };
