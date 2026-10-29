const config = require('../config');
const { reactionMatches } = require('./emoji');

const REAL_POOLS = ['mainball', 'def-team', 'commander', 'shai', 'flex'];

// emojiSet: the event's own emojis (event.emojis); falls back to the current
// configuration for events that predate per-event emojis.
function getPoolFromEmoji(emoji, emojiSet = config.emojis) {
  const set = emojiSet || config.emojis;
  for (const pool of REAL_POOLS) {
    if (reactionMatches(set[pool], emoji)) return pool;
  }
  return null;
}

module.exports = { getPoolFromEmoji };
