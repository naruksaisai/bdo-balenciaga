const { getEvent } = require('../state/eventStore');
const { getPoolFromEmoji } = require('../utils/emojiMap');
const { removeUser } = require('../logic/poolLogic');
const { buildEventEmbed } = require('../logic/messageBuilder');

module.exports = async (reaction, user) => {
  if (user.bot) return;

  if (reaction.partial) await reaction.fetch();
  if (reaction.message.partial) await reaction.message.fetch();

  const event = getEvent(reaction.message.id);
  if (!event) return;

  const pool = getPoolFromEmoji(reaction.emoji, event);
  if (!pool) return;

  // Only process removal if the reaction matches the user's selected pool
  const participant = event.participants[user.id];
  if (!participant || participant.selectedPool !== pool) return;

  removeUser(event, user.id);

  await reaction.message.edit({ embeds: [buildEventEmbed(event)] });
};
