function assignUser(event, userId, username, selectedPool) {
  if (!event.pools[selectedPool] || selectedPool === 'donkey') return;

  // If already in event, remove first (handles switching pools)
  if (event.participants[userId]) {
    _removeFromPools(event, userId);
  }

  event.joinSequence++;

  const limit = event.poolLimits[selectedPool];
  const isFull = limit !== undefined && event.pools[selectedPool].length >= limit;
  const assignedPool = isFull ? 'donkey' : selectedPool;

  event.participants[userId] = {
    userId,
    username,
    selectedPool,
    assignedPool,
    joinOrder: event.joinSequence,
  };

  event.pools[assignedPool].push(userId);
  _sortPool(event, assignedPool);
}

function removeUser(event, userId) {
  const participant = event.participants[userId];
  if (!participant) return;

  const { assignedPool } = participant;
  _removeFromPools(event, userId);
  delete event.participants[userId];

  // If a real pool slot was freed, promote the earliest eligible donkey user
  if (assignedPool !== 'donkey') {
    _promoteFromDonkey(event, assignedPool);
  }
}

function _removeFromPools(event, userId) {
  const participant = event.participants[userId];
  if (!participant) return;
  event.pools[participant.assignedPool] = event.pools[participant.assignedPool].filter(id => id !== userId);
}

function _promoteFromDonkey(event, freedPool) {
  const limit = event.poolLimits[freedPool];
  if (limit !== undefined && event.pools[freedPool].length >= limit) return;

  const candidate = event.pools.donkey
    .map(id => event.participants[id])
    .filter(p => p.selectedPool === freedPool)
    .sort((a, b) => a.joinOrder - b.joinOrder)[0];

  if (!candidate) return;

  event.pools.donkey = event.pools.donkey.filter(id => id !== candidate.userId);
  candidate.assignedPool = freedPool;
  event.pools[freedPool].push(candidate.userId);
  _sortPool(event, freedPool);
}

function _sortPool(event, pool) {
  event.pools[pool].sort((a, b) => event.participants[a].joinOrder - event.participants[b].joinOrder);
}

module.exports = { assignUser, removeUser };
