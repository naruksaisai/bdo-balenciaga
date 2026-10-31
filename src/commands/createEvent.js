const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const config = require('../config');
const scheduleConfig = require('../scheduler/scheduleConfig');
const { blankEvent, createEvent } = require('../state/eventStore');
const { buildEventEmbed } = require('../logic/messageBuilder');

// Slash options are fixed at deploy time, so only the built-in roles get one.
// They apply only while that role still exists; every other role uses its max.
const MAX_OPTIONS = [
  { option: 'mainball_max',  key: 'mainball',  label: 'Mainball' },
  { option: 'def_team_max',  key: 'def-team',  label: 'Def Team' },
  { option: 'commander_max', key: 'commander', label: 'Commander' },
  { option: 'shai_max',      key: 'shai',      label: 'Shai' },
  { option: 'flex_max',      key: 'flex',      label: 'Flex' },
];

const data = new SlashCommandBuilder()
  .setName('create-event')
  .setDescription('Create a BDO raid/node war signup event')
  // Server admins can override this per-role via Server Settings → Integrations.
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageEvents)
  .addStringOption(o => o.setName('title').setDescription('Event title').setRequired(true))
  .addStringOption(o => o.setName('description').setDescription('Event description'));
for (const m of MAX_OPTIONS) {
  data.addIntegerOption(o => o.setName(m.option).setDescription(`Max ${m.label} (default: the role's max in the app)`).setMinValue(1));
}

module.exports = {
  data,

  async execute(interaction) {
    const title = interaction.options.getString('title');
    const description = interaction.options.getString('description') || '';
    const roles = scheduleConfig.getRoles();
    const poolLimits = {};
    for (const r of roles) poolLimits[r.key] = r.max;
    for (const m of MAX_OPTIONS) {
      const v = interaction.options.getInteger(m.option);
      if (v !== null && m.key in poolLimits) poolLimits[m.key] = v;
    }

    await interaction.deferReply();

    const fields = { title, description, roles, poolLimits, donkeyEmoji: config.donkeyEmoji };
    const message = await interaction.editReply({ embeds: [buildEventEmbed(blankEvent(fields))] });

    createEvent(message.id, interaction.channelId, interaction.guildId, fields);

    for (const role of roles) {
      await message.react(role.emoji);
    }
  },
};
