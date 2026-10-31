// Side effects of a saved change from the desktop UI. Returns warnings for the UI.
//   - roles + weekdays: saved into the per-day schedule; days still on a role's
//     old max follow the new one, customized days are preserved
//   - default time: days still on the old default follow it (scheduleConfig)
//   - existing events: pinned to the emojis they were posted with
//   - standbys: get the new schedule right away if this node is the leader
// roles must already be validated (settings/roles.validateRoles).
function applySettingsChange({ prev, next, roles, days }, { scheduleConfig, eventStore, coordinator }) {
  const warnings = [];

  const prevEmojis = { donkey: prev.DONKEY_EMOJI };
  for (const r of scheduleConfig.getRoles()) prevEmojis[r.key] = r.emoji;
  const nextEmojis = { donkey: next.DONKEY_EMOJI };
  for (const r of roles) nextEmojis[r.key] = r.emoji;
  if (JSON.stringify(prevEmojis) !== JSON.stringify(nextEmojis)) {
    const pinned = eventStore.stampMissingEmojis(prevEmojis);
    if (pinned) console.log(`[Settings] Pinned previous emojis on ${pinned} existing event(s).`);
  }

  const changed = new Set();
  try {
    for (const d of scheduleConfig.setRolesAndDays(roles, days)) changed.add(d);
    for (const d of scheduleConfig.applyDefaultsChange({ time: prev.AUTO_EVENT_SCHEDULE }, { time: next.AUTO_EVENT_SCHEDULE })) changed.add(d);
  } catch (err) {
    warnings.push(`The per-day schedule could not be updated: ${err.message}`);
  }

  if (coordinator.isLeader) {
    coordinator.broadcastNow().catch((err) =>
      console.warn('[Settings] Broadcast after settings change failed:', err.message));
  }
  return { warnings, changedDays: scheduleConfig.DAYS.filter((d) => changed.has(d)) };
}

module.exports = { applySettingsChange };
