const fs = require('fs');
const path = require('path');
const schema = require('./schema');

// Discord connection values. They come only from the build (baked), the real
// environment or .env — never from the desktop UI.
const CONNECTION_KEYS = ['DISCORD_BOT_TOKEN', 'CLIENT_ID', 'AUTO_EVENT_CHANNEL_ID', 'COORDINATION_CHANNEL_ID'];
const REQUIRED_CONNECTION_KEYS = ['DISCORD_BOT_TOKEN', 'CLIENT_ID'];

// Populates process.env. Earlier sources win (a key is only set if still empty):
//   1. real process environment
//   2. values baked into the exe by build.js
//   3. .env next to the exe / project root (dev)
//   4. legacy config.json next to the exe (old setup wizard) — connection keys
//      and AUTO_EVENT_ENABLED only; its editable keys are returned for migration.
function loadEnvironment({ baseDir, baked = loadBaked() } = {}) {
  for (const [k, v] of Object.entries(baked)) {
    if (v && !process.env[k]) process.env[k] = v;
  }

  require('dotenv').config({ path: path.join(baseDir, '.env') });

  const legacySettings = {};
  const legacyFile = path.join(baseDir, 'config.json');
  if (fs.existsSync(legacyFile)) {
    try {
      const legacy = JSON.parse(fs.readFileSync(legacyFile, 'utf8'));
      for (const [k, v] of Object.entries(legacy)) {
        if (!v || process.env[k]) continue;
        if (CONNECTION_KEYS.includes(k) || k === 'AUTO_EVENT_ENABLED') process.env[k] = String(v);
        // Only keys that were actually in effect (not overridden by env/baked) migrate,
        // so the effective configuration is identical before and after migration.
        else if (schema.KEYS.includes(k)) legacySettings[k] = v;
      }
    } catch (err) {
      console.warn('[Config] Ignoring unreadable legacy config.json:', err.message);
    }
  }
  return { legacySettings };
}

function loadBaked() {
  try {
    return require('../baked-config');
  } catch {
    return {}; // not a packaged build
  }
}

// Booleans only — the UI must never receive connection values themselves.
function connectionStatus(env = process.env) {
  const missing = REQUIRED_CONNECTION_KEYS.filter((k) => !env[k]);
  return {
    ok: missing.length === 0,
    missing,
    hasCoordinationChannel: !!env.COORDINATION_CHANNEL_ID,
    hasEventChannel: !!env.AUTO_EVENT_CHANNEL_ID,
    autoEventEnabled: env.AUTO_EVENT_ENABLED === 'true',
  };
}

module.exports = { loadEnvironment, connectionStatus, CONNECTION_KEYS, REQUIRED_CONNECTION_KEYS };
