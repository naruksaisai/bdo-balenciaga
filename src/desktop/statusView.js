// Turns backend state into display-ready text for the desktop UI. Kept on the
// Node side (and pure) so the C# UI stays a thin renderer and the wording is
// unit-testable.
const { VISIBLE_INTERVAL_MS } = require('./nodeMonitor');

const STALE_AFTER_MS = 3 * VISIBLE_INTERVAL_MS;
const ROLE_LABELS = { leader: 'Leader', standby: 'Standby', off: 'Off' };

function formatAge(ms) {
  if (!Number.isFinite(ms) || ms < 60 * 1000) return 'just now';
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  return `${h} h ${min % 60} min ago`;
}

function formatClock(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function hostingView(hosting, enabled, connection) {
  const { state, role, detail, error } = hosting;
  const busy = state === 'starting' || state === 'stopping';
  let roleLabel = ROLE_LABELS[role] || 'Off';
  if (role === 'off' && state === 'starting') roleLabel = 'Off (starting…)';
  if (state === 'stopping') roleLabel = `${roleLabel} (stopping…)`;

  let text = error || detail;
  if (!text && !enabled) text = 'Hosting is off: this PC is not running the bot. Node monitoring and settings still work.';
  if (!text && state === 'stopped') {
    text = connection.ok ? 'Hosting is on but not running.' : 'Hosting is on but cannot run: this build has no Discord connection.';
  }
  return {
    enabled,
    label: enabled ? 'ON' : 'OFF',
    roleLabel,
    detail: text || '',
    level: error ? 'error' : busy ? 'busy' : enabled ? 'ok' : 'off',
    // Turning OFF is always allowed; ON needs a working connection.
    canToggle: state !== 'stopping' && (enabled || connection.ok),
  };
}

function nodesView(snap, now, selfHosting) {
  if (!snap || snap.loading) {
    return { level: 'loading', count: '…', detail: 'Checking the coordination channel…', updated: '' };
  }
  const s = snap.summary;
  if (!snap.available) {
    return {
      level: 'unavailable',
      count: s ? String(s.activeCount) : '—',
      detail: `Unavailable: ${snap.reason}`,
      updated: snap.lastSuccessAt ? `Showing the last known count from ${formatClock(snap.lastSuccessAt)}.` : 'No node data yet.',
    };
  }

  const parts = [];
  if (!s.leader) parts.push('No leader online');
  else if (s.leader.active) parts.push(`Leader online (synced ${formatAge(s.leader.ageMs)})`);
  else parts.push(`Leader stale (last sync ${formatAge(s.leader.ageMs)})`);
  parts.push(`${s.standbyActive} standby`);
  if (s.staleCount) parts.push(`${s.staleCount} stale (no heartbeat for 20+ min)`);

  const old = now - snap.lastSuccessAt > STALE_AFTER_MS;
  const level = old || s.staleCount > 0 || !(s.leader && s.leader.active) ? 'stale' : 'ok';
  return {
    level,
    count: String(s.activeCount),
    detail: parts.join(' · ') + (selfHosting ? ' — includes this PC' : ''),
    updated: `Updated ${formatClock(snap.lastSuccessAt)}${old ? ' (out of date)' : ''}. Refreshes automatically.`,
  };
}

function notices(connection) {
  const out = [];
  if (!connection.ok) {
    out.push(`This build has no Discord connection (${connection.missing.join(', ')} missing), so hosting cannot be turned on. Rebuild with these values in .env.`);
  }
  if (!connection.hasCoordinationChannel) {
    out.push('No coordination channel in this build: this PC would host alone and node monitoring is unavailable.');
  }
  if (!connection.autoEventEnabled || !connection.hasEventChannel) {
    out.push('Automatic events are disabled in this build (AUTO_EVENT_ENABLED / AUTO_EVENT_CHANNEL_ID). Settings are still saved.');
  }
  return out;
}

function buildStatusView({ hosting, hostingEnabled, connection, monitor, now = Date.now() }) {
  const h = hostingView(hosting, hostingEnabled, connection);
  const selfHosting = hosting.state === 'running' && hosting.role !== 'off';
  const n = nodesView(monitor, now, selfHosting);
  const roleSuffix = hosting.role !== 'off' ? ` (${ROLE_LABELS[hosting.role]})` : '';
  return {
    hosting: h,
    nodes: n,
    notices: notices(connection),
    tooltip: `BDO Raid Helper - Hosting ${h.label}${roleSuffix}`,
    menuStatus: `Hosting ${h.label} · ${h.roleLabel} · ${n.count} active node(s)`,
  };
}

module.exports = { buildStatusView, formatAge };
