// Pure decision functions for the mini-RAFT protocol. Kept free of network
// calls and mutable state so they can be unit tested in isolation.

// Votes needed to win an election in a cluster of (peerCount + 1) nodes.
function majorityNeeded(peerCount) {
  return Math.floor((peerCount + 1) / 2) + 1;
}

// RAFT election restriction: a candidate's log must be at least as
// up-to-date as the voter's own log.
function isLogUpToDate(candidateLastTerm, candidateLastIndex, selfLastTerm, selfLastIndex) {
  return (
    candidateLastTerm > selfLastTerm ||
    (candidateLastTerm === selfLastTerm && candidateLastIndex >= selfLastIndex)
  );
}

// Whether a vote request should be granted, given the voter's current term
// and who (if anyone) it already voted for this term.
function shouldGrantVote({ term, currentTerm, logUpToDate, votedFor, candidateId }) {
  return term >= currentTerm && logUpToDate && (votedFor === null || votedFor === candidateId);
}

// AppendEntries consistency check: the entry immediately before the new one
// must already exist in the follower's log with a matching term.
function prevLogMatches(log, prevLogIndex, prevLogTerm) {
  if (prevLogIndex < 0) return true;
  const prevEntry = log[prevLogIndex];
  return Boolean(prevEntry) && prevEntry.term === prevLogTerm;
}

// True if this entry has already been applied at this index with this term
// (a retried/duplicate AppendEntries request).
function isDuplicateEntry(log, entry) {
  return entry.index < log.length && log[entry.index] && log[entry.index].term === entry.term;
}

module.exports = {
  majorityNeeded,
  isLogUpToDate,
  shouldGrantVote,
  prevLogMatches,
  isDuplicateEntry,
};
