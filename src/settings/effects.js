const { toEmojiMap, toPoolLimits } = require('./schema');

// Side effects of a saved settings change. Returns warnings for the UI.
//   - per-day schedule: days still on the old default time/limits follow the
//     new defaults; customized days are preserved (scheduleConfig handles it)
//   - existing events: pinned to the emojis they were posted with
//   - standbys: get the new schedule right away if this node is the leader
function applySettingsChange({ prev, next }, { scheduleConfig, eventStore, coordinator }) {
  const warnings = [];

  const prevEmojis = toEmojiMap(prev);
  if (JSON.stringify(prevEmojis) !== JSON.stringify(toEmojiMap(next))) {
    const pinned = eventStore.stampMissingEmojis(prevEmojis);
    if (pinned) console.log(`[Settings] Pinned previous emojis on ${pinned} existing event(s).`);
  }

  let changedDays = [];
  try {
    changedDays = scheduleConfig.applyDefaultsChange(
      { time: prev.AUTO_EVENT_SCHEDULE, pools: toPoolLimits(prev) },
      { time: next.AUTO_EVENT_SCHEDULE, pools: toPoolLimits(next) },
    );
  } catch (err) {
    warnings.push(`The per-day schedule could not be updated: ${err.message}`);
  }

  if (coordinator.isLeader) {
    coordinator.broadcastNow().catch((err) =>
      console.warn('[Settings] Broadcast after settings change failed:', err.message));
  }
  return { warnings, changedDays };
}

module.exports = { applySettingsChange };
