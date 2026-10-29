const { EmbedBuilder } = require('discord.js');
const config = require('../config');

const REAL_POOLS = ['mainball', 'def-team', 'commander', 'shai', 'flex'];

const POOL_LABELS = {
  mainball: 'Mainball',
  'def-team': 'Def Team',
  commander: 'Commander',
  shai: 'Shai',
  flex: 'Flex',
  donkey: 'Donkey (Overflow)',
};

function buildEventEmbed(event) {
  const totalParticipants = Object.keys(event.participants).length;
  const emojis = event.emojis || config.emojis;

  const embed = new EmbedBuilder()
    .setTitle(event.title)
    .setColor(0xe8a735)
    .setDescription(event.description || '​')
    .addFields({ name: '👥 Total Participants', value: String(totalParticipants), inline: false });

  for (const pool of REAL_POOLS) {
    const emoji = emojis[pool];
    const limit = event.poolLimits[pool] ?? '∞';
    const members = event.pools[pool];
    const memberList = members.length > 0
      ? members.map((id, i) => `${i + 1}. ${event.participants[id].username}`).join('\n')
      : '_Empty_';

    embed.addFields({
      name: `${emoji} ${POOL_LABELS[pool]} (${members.length}/${limit})`,
      value: memberList,
      inline: true,
    });
  }

  const donkeyMembers = event.pools.donkey;
  if (donkeyMembers.length > 0) {
    const donkeyList = donkeyMembers
      .map((id, i) => `${i + 1}. ${event.participants[id].username} (${event.participants[id].selectedPool})`)
      .join('\n');

    embed.addFields({
      name: `${emojis.donkey} ${POOL_LABELS.donkey} (${donkeyMembers.length})`,
      value: donkeyList,
      inline: false,
    });
  }

  embed.setFooter({ text: 'React below to join your pool! Remove your reaction to leave.' });

  return embed;
}

module.exports = { buildEventEmbed };
