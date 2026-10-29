// In-memory map: messageId -> eventState
const events = new Map();

function createEvent(messageId, channelId, guildId, { title, description, poolLimits, emojis }) {
  events.set(messageId, {
    messageId,
    channelId,
    guildId,
    title,
    description,
    poolLimits,
    // Emojis the card was posted with. Reactions keep mapping to pools even if
    // the configured emojis change later.
    emojis: { ...emojis },
    // participants: userId -> { userId, username, selectedPool, assignedPool, joinOrder }
    participants: {},
    pools: {
      mainball: [],
      'def-team': [],
      commander: [],
      shai: [],
      flex: [],
      donkey: [],
    },
    joinSequence: 0,
  });
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

module.exports = { createEvent, getEvent, deleteEvent, exportState, importState, stampMissingEmojis };
