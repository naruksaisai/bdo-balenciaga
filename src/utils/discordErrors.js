const { redact } = require('./logger');

// Turns a Discord REST failure into a sentence a user can act on.
function describeDiscordError(err) {
  const status = err && (err.status || err.httpStatus);
  const message = (err && err.message) || String(err);
  // @discordjs/rest clears its token after a 401 (to avoid an IP ban for
  // repeated invalid requests), so later calls fail with this message instead.
  if (status === 401 || /Expected token to be set/.test(message)) return 'Discord rejected the bot token.';
  if (status === 403) return 'The bot lacks permission for this channel or server.';
  if (status === 404) return 'The channel or server was not found.';
  if (status === 429) return 'Discord is rate limiting requests.';
  const code = err && (err.code || (err.cause && err.cause.code));
  if (typeof code === 'string' && code.startsWith('E')) return `Discord is unreachable (${code}).`;
  return redact(message);
}

module.exports = { describeDiscordError };
