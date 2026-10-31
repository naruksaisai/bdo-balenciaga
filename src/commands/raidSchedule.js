const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const scheduleConfig = require('../scheduler/scheduleConfig');
const coordinator = require('../ha/coordinator');

const DAY_CHOICES = [
  { name: 'Monday',    value: 'monday'    },
  { name: 'Tuesday',   value: 'tuesday'   },
  { name: 'Wednesday', value: 'wednesday' },
  { name: 'Thursday',  value: 'thursday'  },
  { name: 'Friday',    value: 'friday'    },
  { name: 'Saturday',  value: 'saturday'  },
  { name: 'Sunday',    value: 'sunday'    },
];

const DAY_ORDER = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

function cap(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function poolSummary(schedule, d) {
  return schedule.roles.map((r) => `${r.emoji}${d.pools[r.key]}`).join(' ');
}

function buildAllDaysEmbed(schedule) {
  const lines = DAY_ORDER.map((day) => {
    const d = schedule[day];
    const status = d.enabled ? '✅' : '❌';
    return `**${cap(day)}** ${status} \`${d.time}\` — ${poolSummary(schedule, d)}`;
  });

  return new EmbedBuilder()
    .setTitle('📅 Raid Schedule')
    .setDescription(lines.join('\n'))
    .setColor(0x5865F2);
}

function buildDayEmbed(day, d, roles) {
  return new EmbedBuilder()
    .setTitle(`📅 ${cap(day)} Schedule`)
    .addFields(
      { name: 'Status', value: d.enabled ? '✅ Enabled' : '❌ Disabled', inline: true },
      { name: 'Time',   value: `\`${d.time}\``,                           inline: true },
      { name: '​', value: '​',                                   inline: true },
      ...roles.map((r) => ({ name: `${r.emoji} ${r.label}`, value: `${d.pools[r.key]}`, inline: true })),
    )
    .setColor(d.enabled ? 0x57F287 : 0xED4245);
}

// Slash options are fixed at deploy time: the built-in roles get one each, and
// any role (including added ones) can be set by name with role + max.
const BUILTIN_OPTIONS = [
  { option: 'mainball',  key: 'mainball' },
  { option: 'def_team',  key: 'def-team' },
  { option: 'commander', key: 'commander' },
  { option: 'shai',      key: 'shai' },
  { option: 'flex',      key: 'flex' },
];

function findRole(roles, name) {
  const n = name.trim().toLowerCase();
  return roles.find((r) => r.key === n || r.label.toLowerCase() === n);
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('raid-schedule')
    .setDescription('View or update the auto-event schedule')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) =>
      sub
        .setName('view')
        .setDescription('Show the current event schedule')
        .addStringOption((o) =>
          o.setName('day')
            .setDescription('Specific day to inspect (omit for full schedule)')
            .addChoices(...DAY_CHOICES)))
    .addSubcommand((sub) =>
      sub
        .setName('set-time')
        .setDescription('Update the event time for a day')
        .addStringOption((o) =>
          o.setName('day').setDescription('Day of the week').setRequired(true).addChoices(...DAY_CHOICES))
        .addStringOption((o) =>
          o.setName('time').setDescription('Event time in 24h format (e.g. 21:00)').setRequired(true))
        .addBooleanOption((o) =>
          o.setName('enabled').setDescription('Enable or disable this day')))
    .addSubcommand((sub) =>
      sub
        .setName('set-pools')
        .setDescription('Update pool capacity for a day')
        .addStringOption((o) =>
          o.setName('day').setDescription('Day of the week').setRequired(true).addChoices(...DAY_CHOICES))
        .addIntegerOption((o) => o.setName('mainball').setDescription('Mainball capacity').setMinValue(1))
        .addIntegerOption((o) => o.setName('def_team').setDescription('Def-team capacity').setMinValue(1))
        .addIntegerOption((o) => o.setName('commander').setDescription('Commander capacity').setMinValue(1))
        .addIntegerOption((o) => o.setName('shai').setDescription('Shai capacity').setMinValue(1))
        .addIntegerOption((o) => o.setName('flex').setDescription('Flex capacity').setMinValue(1))
        .addStringOption((o) => o.setName('role').setDescription('Any role by name (use with max)'))
        .addIntegerOption((o) => o.setName('max').setDescription('Capacity for the named role').setMinValue(1))),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    // ── view ──────────────────────────────────────────────────────────────────
    if (sub === 'view') {
      const day = interaction.options.getString('day');
      if (day) {
        const dayCfg = scheduleConfig.get(day);
        return interaction.reply({ embeds: [buildDayEmbed(day, dayCfg, scheduleConfig.getRoles())], ephemeral: true });
      }
      return interaction.reply({ embeds: [buildAllDaysEmbed(scheduleConfig.get())], ephemeral: true });
    }

    // ── set-time / set-pools ─────────────────────────────────────────────────
    const day = interaction.options.getString('day');
    await interaction.deferReply({ ephemeral: true });

    try {
      if (sub === 'set-time') {
        const time    = interaction.options.getString('time');
        const enabled = interaction.options.getBoolean('enabled'); // null if not provided
        const patch   = { time };
        if (enabled !== null) patch.enabled = enabled;
        scheduleConfig.update(day, patch);

      } else if (sub === 'set-pools') {
        const pools = {};
        const roles = scheduleConfig.getRoles();
        for (const b of BUILTIN_OPTIONS) {
          const v = interaction.options.getInteger(b.option);
          if (v === null) continue;
          if (!roles.some((r) => r.key === b.key)) {
            return interaction.editReply(`❌ The ${b.option} role has been removed in the app.`);
          }
          pools[b.key] = v;
        }
        const roleName = interaction.options.getString('role');
        const roleMax = interaction.options.getInteger('max');
        if ((roleName === null) !== (roleMax === null)) {
          return interaction.editReply('❌ Use role and max together.');
        }
        if (roleName !== null) {
          const role = findRole(roles, roleName);
          if (!role) return interaction.editReply(`❌ No role named "${roleName}". Roles: ${roles.map((r) => r.label).join(', ')}`);
          pools[role.key] = roleMax;
        }

        if (Object.keys(pools).length === 0) {
          return interaction.editReply('❌ Provide at least one pool capacity to update.');
        }
        scheduleConfig.update(day, { pools });
      }
    } catch (err) {
      return interaction.editReply(`❌ ${err.message}`);
    }

    // Push the new schedule to standbys immediately
    if (coordinator.isLeader) {
      coordinator.broadcastNow().catch((err) =>
        console.warn('[RaidSchedule] Broadcast after update failed:', err.message)
      );
    }

    const dayCfg = scheduleConfig.get(day);
    await interaction.editReply({ embeds: [buildDayEmbed(day, dayCfg, scheduleConfig.getRoles())] });
  },
};
