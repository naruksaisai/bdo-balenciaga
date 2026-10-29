// Interprets raw coordination-channel messages (Discord REST shape) as nodes.
// Pure, so the desktop node monitor and tests share one definition of "active".

// A node is active while its heartbeat is younger than the leader timeout:
// leaders repost state every 15 min and standbys refresh presence on the same
// cadence, so anything older has missed at least one beat.
const LEADER_TIMEOUT_MS = 20 * 60 * 1000; // must be > coordinator SYNC_INTERVAL_MS

const PRESENCE_RE = /^\[NODE\] `([^`]+)` \| \*\*(\w+)\*\*/;
const LEADER_ID_RE = /`(node-[^`]+)`/;

function isPresenceMessage(content) {
  return PRESENCE_RE.test(content || '');
}

function isStateMessage(m) {
  return Array.isArray(m.attachments) && m.attachments.some((a) => a.filename === 'state.json');
}

// Returns { leader: { id, ageMs, active } | null, standbyActive, standbyStale,
//           activeCount, staleCount }
function summarizeNodes(messages, now = Date.now(), { activeMs = LEADER_TIMEOUT_MS } = {}) {
  let leader = null;
  let standbyActive = 0;
  let standbyStale = 0;

  for (const m of messages || []) {
    if (!m || !m.author || !m.author.bot) continue;

    if (isStateMessage(m)) {
      // Leader liveness uses creation time: the leader reposts (not edits) every
      // sync, while standbys only *edit* the card to mark it offline.
      const ageMs = now - Date.parse(m.timestamp);
      if (!leader || ageMs < leader.ageMs) {
        const id = (LEADER_ID_RE.exec(m.content || '') || [])[1] || null;
        leader = { id, ageMs, active: ageMs < activeMs };
      }
      continue;
    }

    if (!isPresenceMessage(m.content)) continue;
    const ageMs = now - Date.parse(m.edited_timestamp || m.timestamp);
    if (ageMs < activeMs) standbyActive++;
    else standbyStale++;
  }

  const leaderActive = !!(leader && leader.active);
  return {
    leader,
    standbyActive,
    standbyStale,
    activeCount: (leaderActive ? 1 : 0) + standbyActive,
    staleCount: (leader && !leaderActive ? 1 : 0) + standbyStale,
  };
}

module.exports = { summarizeNodes, isPresenceMessage, LEADER_TIMEOUT_MS };
