// Load .env when running from source; main.js handles baked values for packaged builds
require('dotenv').config();
const settingsStore = require('./settings/settingsStore');
const { toEmojiMap, toPoolLimits } = require('./settings/schema');

// Getters, not snapshots: user settings can change at runtime from the desktop
// UI, and every future event must use the values in effect at that moment.
module.exports = {
  get token() { return process.env.DISCORD_BOT_TOKEN; },
  get clientId() { return process.env.CLIENT_ID; },
  get coordinationChannelId() { return process.env.COORDINATION_CHANNEL_ID || ''; },
  get emojis() { return toEmojiMap(settingsStore.getEffective()); },
  get autoEvent() {
    const s = settingsStore.getEffective();
    return {
      enabled: process.env.AUTO_EVENT_ENABLED === 'true',
      channelId: process.env.AUTO_EVENT_CHANNEL_ID || '',
      schedule: s.AUTO_EVENT_SCHEDULE,
      title: s.AUTO_EVENT_TITLE,
      description: s.AUTO_EVENT_DESCRIPTION,
      poolLimits: toPoolLimits(s),
    };
  },
};
