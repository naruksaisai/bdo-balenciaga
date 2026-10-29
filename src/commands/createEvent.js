const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const config = require('../config');
const { createEvent } = require('../state/eventStore');
const { buildEventEmbed } = require('../logic/messageBuilder');

const DEFAULT_LIMITS = { mainball: 20, 'def-team': 10, commander: 2, shai: 3, flex: 5 };

module.exports = {
  data: new SlashCommandBuilder()
    .setName('create-event')
    .setDescription('Create a BDO raid/node war signup event')
    // Server admins can override this per-role via Server Settings → Integrations.
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageEvents)
    .addStringOption(o => o.setName('title').setDescription('Event title').setRequired(true))
    .addStringOption(o => o.setName('description').setDescription('Event description'))
    .addIntegerOption(o => o.setName('mainball_max').setDescription(`Max Mainball (default ${DEFAULT_LIMITS.mainball})`).setMinValue(1))
    .addIntegerOption(o => o.setName('def_team_max').setDescription(`Max Def Team (default ${DEFAULT_LIMITS['def-team']})`).setMinValue(1))
    .addIntegerOption(o => o.setName('commander_max').setDescription(`Max Commander (default ${DEFAULT_LIMITS.commander})`).setMinValue(1))
    .addIntegerOption(o => o.setName('shai_max').setDescription(`Max Shai (default ${DEFAULT_LIMITS.shai})`).setMinValue(1))
    .addIntegerOption(o => o.setName('flex_max').setDescription(`Max Flex (default ${DEFAULT_LIMITS.flex})`).setMinValue(1)),

  async execute(interaction) {
    const title = interaction.options.getString('title');
    const description = interaction.options.getString('description') || '';
    const poolLimits = {
      mainball: interaction.options.getInteger('mainball_max') ?? DEFAULT_LIMITS.mainball,
      'def-team': interaction.options.getInteger('def_team_max') ?? DEFAULT_LIMITS['def-team'],
      commander: interaction.options.getInteger('commander_max') ?? DEFAULT_LIMITS.commander,
      shai: interaction.options.getInteger('shai_max') ?? DEFAULT_LIMITS.shai,
      flex: interaction.options.getInteger('flex_max') ?? DEFAULT_LIMITS.flex,
    };

    await interaction.deferReply();

    const tempEvent = {
      title, description, poolLimits,
      pools: { mainball: [], 'def-team': [], commander: [], shai: [], flex: [], donkey: [] },
      participants: {},
    };

    const emojis = config.emojis;
    tempEvent.emojis = emojis;
    const embed = buildEventEmbed(tempEvent);
    const message = await interaction.editReply({ embeds: [embed] });

    createEvent(message.id, interaction.channelId, interaction.guildId, {
      title, description, poolLimits, emojis,
    });

    for (const pool of ['mainball', 'def-team', 'commander', 'shai', 'flex']) {
      await message.react(emojis[pool]);
    }
  },
};
