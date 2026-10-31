const { getEvent } = require('../state/eventStore');
const { getPoolFromEmoji } = require('../utils/emojiMap');
const { assignUser } = require('../logic/poolLogic');
const { buildEventEmbed } = require('../logic/messageBuilder');

module.exports = async (reaction, user) => {
  if (user.bot) return;

  if (reaction.partial) await reaction.fetch();
  if (reaction.message.partial) await reaction.message.fetch();

  const event = getEvent(reaction.message.id);
  if (!event) return;

  const pool = getPoolFromEmoji(reaction.emoji, event);
  if (!pool) return;

  const member = await reaction.message.guild.members.fetch(user.id);
  assignUser(event, user.id, member.displayName, pool);

  await reaction.message.edit({ embeds: [buildEventEmbed(event)] });
};
