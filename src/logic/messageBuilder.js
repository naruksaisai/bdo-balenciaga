const { EmbedBuilder } = require('discord.js');
const config = require('../config');
const { eventRoles } = require('../state/eventStore');
const { DONKEY } = require('../settings/schema');

function buildEventEmbed(event) {
  const totalParticipants = Object.keys(event.participants).length;
  const donkeyEmoji = (event.emojis && event.emojis.donkey) || config.donkeyEmoji;

  const embed = new EmbedBuilder()
    .setTitle(event.title)
    .setColor(0xe8a735)
    .setDescription(event.description || '​')
    .addFields({ name: '👥 Total Participants', value: String(totalParticipants), inline: false });

  for (const role of eventRoles(event)) {
    const limit = event.poolLimits[role.key] ?? '∞';
    const members = event.pools[role.key] || [];
    const memberList = members.length > 0
      ? members.map((id, i) => `${i + 1}. ${event.participants[id].username}`).join('\n')
      : '_Empty_';

    embed.addFields({
      name: `${role.emoji} ${role.label} (${members.length}/${limit})`,
      value: memberList,
      inline: true,
    });
  }

  const donkeyMembers = event.pools.donkey;
  if (donkeyMembers.length > 0) {
    const labels = new Map(eventRoles(event).map((r) => [r.key, r.label]));
    const donkeyList = donkeyMembers
      .map((id, i) => {
        const p = event.participants[id];
        return `${i + 1}. ${p.username} (${labels.get(p.selectedPool) || p.selectedPool})`;
      })
      .join('\n');

    embed.addFields({
      name: `${donkeyEmoji} ${DONKEY.label} (${donkeyMembers.length})`,
      value: donkeyList,
      inline: false,
    });
  }

  embed.setFooter({ text: 'React below to join your pool! Remove your reaction to leave.' });

  return embed;
}

module.exports = { buildEventEmbed };
