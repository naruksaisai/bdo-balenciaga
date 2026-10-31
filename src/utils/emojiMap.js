const { reactionMatches } = require('./emoji');
const { eventRoles } = require('../state/eventStore');

// Maps a reaction to one of the roles the event was posted with.
function getPoolFromEmoji(emoji, event) {
  for (const role of eventRoles(event)) {
    if (reactionMatches(role.emoji, emoji)) return role.key;
  }
  return null;
}

module.exports = { getPoolFromEmoji };
