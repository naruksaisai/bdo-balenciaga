const { Routes } = require('discord.js');
const { parseEmoji } = require('../utils/emoji');
const { POOLS } = require('./schema');
const { describeDiscordError } = require('../utils/discordErrors');

const MAX_GUILDS_CHECKED = 10;

// A bot can react with a custom emoji only if it is in that emoji's server.
// Checks the event channel's server first, then the bot's other servers.
// Returns { errors: { KEY: msg }, warnings: [msg] }. Network failures become a
// warning (the emoji is saved unverified) rather than blocking the save.
async function checkCustomEmojis(values, { rest, eventChannelId }) {
  const custom = POOLS
    .map((p) => ({ key: p.emojiKey, label: p.label, parsed: parseEmoji(values[p.emojiKey]) }))
    .filter((e) => e.parsed && e.parsed.kind === 'custom');
  if (!custom.length) return { errors: {}, warnings: [] };
  if (!rest) return { errors: {}, warnings: ['Custom emojis could not be verified (no Discord connection in this build).'] };

  try {
    const available = new Set();
    const guildIds = [];
    if (eventChannelId) {
      const channel = await rest.get(Routes.channel(eventChannelId));
      if (channel.guild_id) guildIds.push(channel.guild_id);
    }
    const missing = () => custom.filter((e) => !available.has(e.parsed.id));

    for (const id of guildIds) {
      for (const emoji of await rest.get(Routes.guildEmojis(id))) available.add(emoji.id);
    }
    if (missing().length) {
      const guilds = await rest.get(Routes.userGuilds());
      for (const g of guilds.filter((x) => !guildIds.includes(x.id)).slice(0, MAX_GUILDS_CHECKED)) {
        for (const emoji of await rest.get(Routes.guildEmojis(g.id))) available.add(emoji.id);
        if (!missing().length) break;
      }
    }

    const errors = {};
    for (const e of missing()) {
      errors[e.key] = `The bot can't use :${e.parsed.name}: — it isn't in a server the bot has joined.`;
    }
    return { errors, warnings: [] };
  } catch (err) {
    return { errors: {}, warnings: [`Custom emojis were saved without verification: ${describeDiscordError(err)}`] };
  }
}

module.exports = { checkCustomEmojis };
