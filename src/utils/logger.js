const fs = require('fs');
const path = require('path');
const util = require('util');

const LOG_FILE_NAME = 'bdo-raid-helper.log';
const MAX_LOG_BYTES = 5 * 1024 * 1024;

// Shape of a Discord bot token: base64 user id . timestamp . HMAC.
const TOKEN_RE = /[A-Za-z0-9_-]{23,28}\.[A-Za-z0-9_-]{6,7}\.[A-Za-z0-9_-]{27,}/g;

// Removes the bot token from any text bound for a log, an error message or the
// UI. Matches the configured token exactly and anything token-shaped.
function redact(text) {
  let s = String(text);
  const token = process.env.DISCORD_BOT_TOKEN;
  if (token && token.length >= 8) s = s.split(token).join('[REDACTED]');
  return s.replace(TOKEN_RE, '[REDACTED]');
}

function formatArgs(args) {
  return redact(args.map((a) => (typeof a === 'string' ? a : util.inspect(a, { depth: 3 }))).join(' '));
}

function logFilePath(logDir) {
  return path.join(logDir, LOG_FILE_NAME);
}

// Earliest-possible boot marker — written before anything else can crash.
// Lets us distinguish "Windows didn't auto-start us" from "we crashed early".
function writeBootMarker(logDir) {
  try {
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(
      logFilePath(logDir),
      `[${new Date().toISOString()}] [BOOT ] process started, argv=${JSON.stringify(process.argv.slice(1))}\n`
    );
  } catch { /* best-effort */ }
}

// Routes console.* to the log file (always redacted). In dev the original
// console output is kept as well; the packaged GUI exe has no console.
function installFileLogging(logDir, { mirrorToConsole = false } = {}) {
  const file = logFilePath(logDir);
  try {
    fs.mkdirSync(logDir, { recursive: true });
    if (fs.existsSync(file) && fs.statSync(file).size > MAX_LOG_BYTES) {
      fs.renameSync(file, `${file}.1`);
    }
  } catch { /* rotation is best-effort */ }

  // Synchronous writes: a native crash or process.exit() must not swallow the
  // last lines (a buffered stream once hid a startup segfault entirely).
  let fd = null;
  try {
    fd = fs.openSync(file, 'a');
  } catch { /* unwritable log dir — keep running without a file log */ }

  const ts = () => new Date().toISOString();
  for (const lvl of ['log', 'info', 'warn', 'error']) {
    const original = console[lvl].bind(console);
    console[lvl] = (...args) => {
      const line = formatArgs(args);
      if (fd !== null) {
        try { fs.writeSync(fd, `[${ts()}] [${lvl.toUpperCase().padEnd(5)}] ${line}\n`); } catch { /* disk full etc. */ }
      }
      if (mirrorToConsole) original(line);
    };
  }
  return file;
}

module.exports = { redact, writeBootMarker, installFileLogging, logFilePath };
