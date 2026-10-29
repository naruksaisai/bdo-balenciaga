const path = require('path');
const os = require('os');
const BASE_DIR = require('./baseDir');

// Mutable per-user data (settings, schedule, state cache, logs) lives here, never
// next to the exe: the exe may sit in a protected folder like Program Files.
//   BDO_DATA_DIR env  → explicit override (tests, portable setups)
//   packaged exe      → %LOCALAPPDATA%\BDO Raid Helper
//   dev (npm start)   → <project>/.data so dev runs never touch the real install
function resolveDataDir(env = process.env, isPkg = typeof process.pkg !== 'undefined') {
  if (env.BDO_DATA_DIR) return path.resolve(env.BDO_DATA_DIR);
  if (!isPkg) return path.join(BASE_DIR, '.data');
  const local = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(local, 'BDO Raid Helper');
}

const DATA_DIR = resolveDataDir();
const LOG_DIR = path.join(DATA_DIR, 'logs');

module.exports = { DATA_DIR, LOG_DIR, resolveDataDir };
