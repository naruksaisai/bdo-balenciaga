// Emoji parsing shared by settings validation and reaction → pool mapping.

const CUSTOM_RE = /^<(a?):([A-Za-z0-9_]{2,32}):(\d{17,20})>$/;
// Exactly one emoji: a flag (two regional indicators), a keycap, or pictographs
// (each with optional VS16, skin tone and tag sequence) joined by ZWJ.
// Deliberately regex-only: Intl.Segmenter segfaults in pkg's node18 runtime
// (reduced ICU data), which crashed the packaged exe at startup.
const PICT = '\\p{Extended_Pictographic}\\uFE0F?\\p{Emoji_Modifier}?(?:[\\u{E0020}-\\u{E007E}]+\\u{E007F})?';
const SINGLE_EMOJI_RE = new RegExp(`^(?:\\p{Regional_Indicator}{2}|[#*0-9]\\uFE0F?\\u20E3|${PICT}(?:\\u200D${PICT})*)$`, 'u');
const MAX_UNICODE_LENGTH = 32;

// Discord sometimes reports '⚔' for a configured '⚔️' (or vice versa): the
// U+FE0F variation selector is presentation-only, so ignore it when comparing.
function stripVariation(s) {
  return String(s).replace(/️/g, '');
}

// Returns { kind:'custom', value, name, id, animated, key }
//       | { kind:'unicode', value, key }
//       | null (not a usable emoji).
// `key` identifies the emoji regardless of formatting, for duplicate checks.
function parseEmoji(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (!s) return null;

  const custom = CUSTOM_RE.exec(s);
  if (custom) {
    const [, a, name, id] = custom;
    return { kind: 'custom', value: `<${a}:${name}:${id}>`, name, id, animated: a === 'a', key: `id:${id}` };
  }

  if (s.length > MAX_UNICODE_LENGTH) return null;
  if (!SINGLE_EMOJI_RE.test(s)) return null;
  return { kind: 'unicode', value: s, key: stripVariation(s) };
}

// True when a reaction emoji (discord.js GuildEmoji/ReactionEmoji: { id, name })
// is the configured emoji string.
function reactionMatches(configured, reactionEmoji) {
  if (!configured || !reactionEmoji) return false;
  const parsed = parseEmoji(configured);
  if (parsed && parsed.kind === 'custom') return reactionEmoji.id === parsed.id;
  if (parsed && parsed.kind === 'unicode') {
    return !reactionEmoji.id && stripVariation(reactionEmoji.name || '') === parsed.key;
  }
  // Legacy: a custom emoji configured by bare name.
  return configured === reactionEmoji.name;
}

module.exports = { parseEmoji, reactionMatches, stripVariation };
