const express = require("express");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

// ── Config ────────────────────────────────────────────────────────────────────
const ID = process.env.REPLICA_ID;
const PORT = parseInt(process.env.PORT);
const PEERS = process.env.PEERS ? process.env.PEERS.split(",") : [];

// ── State ─────────────────────────────────────────────────────────────────────
let state = "follower";   // follower | candidate | leader
let currentTerm = 0;
let votedFor = null;
let log = [];             // [ { term, index, data } ]
let commitIndex = -1;
let leaderId = null;

let electionTimer = null;
let heartbeatTimer = null;

// ── Structured Logging ────────────────────────────────────────────────────────
function raft_log(event, detail = "") {
  const ts = new Date().toISOString();
  console.log(JSON.stringify({ ts, id: ID, term: currentTerm, state, event, detail }));
}

// ── RPC helper ────────────────────────────────────────────────────────────────
async function rpc(peer, path, body) {
  try {
    const res = await fetch(`${peer}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      timeout: 400,
    });
    return await res.json();
  } catch {
    return null;
  }
}

// ── Election timer ────────────────────────────────────────────────────────────
function randomTimeout() {
  return Math.floor(Math.random() * 300) + 500; // 500–800 ms
}

function resetElectionTimer() {
  clearTimeout(electionTimer);
  electionTimer = setTimeout(startElection, randomTimeout());
}

// ── Election ──────────────────────────────────────────────────────────────────
async function startElection() {
  state = "candidate";
  currentTerm++;
  votedFor = ID;
  leaderId = null;
  raft_log("ELECTION_START", `term=${currentTerm}`);

  let votes = 1;
  const lastIndex = log.length - 1;
  const lastTerm = lastIndex >= 0 ? log[lastIndex].term : 0;

  const results = await Promise.all(
    PEERS.map((peer) =>
      rpc(peer, "/request-vote", {
        term: currentTerm,
        candidateId: ID,
        lastLogIndex: lastIndex,
        lastLogTerm: lastTerm,
      })
    )
  );

  for (const r of results) {
    if (!r) continue;
    if (r.term > currentTerm) { stepDown(r.term); return; }
    if (r.voteGranted) votes++;
  }

  const majority = Math.floor((PEERS.length + 1) / 2) + 1;
  raft_log("VOTES_RECEIVED", `votes=${votes} needed=${majority}`);

  if (state === "candidate" && votes >= majority) {
    becomeLeader();
  } else if (state === "candidate") {
    raft_log("SPLIT_VOTE", "retrying after timeout");
    state = "follower";
    resetElectionTimer();
  }
}

function becomeLeader() {
  state = "leader";
  leaderId = ID;
  raft_log("BECAME_LEADER", `term=${currentTerm}`);
  clearTimeout(electionTimer);
  sendHeartbeats();
  heartbeatTimer = setInterval(sendHeartbeats, 150);
}

function stepDown(newTerm) {
  raft_log("STEP_DOWN", `new_term=${newTerm}`);
  clearInterval(heartbeatTimer);
  state = "follower";
  currentTerm = newTerm;
  votedFor = null;
  resetElectionTimer();
}

// ── Heartbeats ────────────────────────────────────────────────────────────────
async function sendHeartbeats() {
  if (state !== "leader") return;
  for (const peer of PEERS) {
    rpc(peer, "/heartbeat", { term: currentTerm, leaderId: ID });
  }
}

// ── /request-vote ─────────────────────────────────────────────────────────────
app.post("/request-vote", (req, res) => {
  const { term, candidateId, lastLogIndex, lastLogTerm } = req.body;

  if (term > currentTerm) stepDown(term);

  const myLastIndex = log.length - 1;
  const myLastTerm = myLastIndex >= 0 ? log[myLastIndex].term : 0;

  const logOk =
    lastLogTerm > myLastTerm ||
    (lastLogTerm === myLastTerm && lastLogIndex >= myLastIndex);

  const voteGranted =
    term >= currentTerm &&
    logOk &&
    (votedFor === null || votedFor === candidateId);

  if (voteGranted) {
    votedFor = candidateId;
    currentTerm = term;
    raft_log("VOTE_GRANTED", `for=${candidateId} term=${term}`);
    resetElectionTimer();
  } else {
    raft_log("VOTE_DENIED", `for=${candidateId} term=${term} logOk=${logOk} votedFor=${votedFor}`);
  }

  res.json({ term: currentTerm, voteGranted });
});

// ── /heartbeat ────────────────────────────────────────────────────────────────
app.post("/heartbeat", (req, res) => {
  const { term, leaderId: newLeader } = req.body;
  if (term >= currentTerm) {
    if (term > currentTerm) {
      raft_log("HEARTBEAT_NEW_TERM", `from=${newLeader} term=${term}`);
      currentTerm = term;
      votedFor = null;
    }
    if (state !== "follower") {
      raft_log("STEP_DOWN", `heartbeat from leader ${newLeader}`);
      clearInterval(heartbeatTimer);
    }
    state = "follower";
    leaderId = newLeader;
    resetElectionTimer();
  }
  res.json({ term: currentTerm });
});

// ── /append-entries ───────────────────────────────────────────────────────────
app.post("/append-entries", (req, res) => {
  const { term, leaderId: newLeader, entry, prevLogIndex, prevLogTerm } = req.body;

  if (term < currentTerm) {
    raft_log("APPEND_REJECTED", `stale term ${term}`);
    return res.json({ success: false, term: currentTerm });
  }

  if (term > currentTerm) { currentTerm = term; votedFor = null; }
  if (state !== "follower") {
    clearInterval(heartbeatTimer);
    raft_log("STEP_DOWN", `append-entries from ${newLeader}`);
  }
  state = "follower";
  leaderId = newLeader;
  resetElectionTimer();

  // Consistency check — prevLogIndex must match
  if (prevLogIndex >= 0) {
    const prevEntry = log[prevLogIndex];
    if (!prevEntry || prevEntry.term !== prevLogTerm) {
      raft_log("LOG_MISMATCH", `prevIdx=${prevLogIndex} myLen=${log.length} — needs sync`);
      // Return our log length so leader knows where to start the sync
      return res.json({ success: false, logLength: log.length, term: currentTerm });
    }
  }

  // Duplicate check
  if (entry.index < log.length && log[entry.index] && log[entry.index].term === entry.term) {
    return res.json({ success: true, term: currentTerm });
  }

  // Truncate conflicting tail and append
  log = log.slice(0, entry.index);
  log.push(entry);
  commitIndex = entry.index;
  raft_log("ENTRY_COMMITTED", `index=${commitIndex}`);

  res.json({ success: true, term: currentTerm });
});

// ── /sync-log ─────────────────────────────────────────────────────────────────
// Leader PUSHES missing entries to this follower (catch-up protocol).
// Called by the leader after detecting a log mismatch in /append-entries ack.
app.post("/sync-log", (req, res) => {
  const { entries, leaderCommitIndex } = req.body;

  if (!Array.isArray(entries) || entries.length === 0) {
    return res.json({ ok: true });
  }

  raft_log("SYNC_LOG_RECV", `receiving ${entries.length} missing entries from leader`);

  for (const entry of entries) {
    if (entry.index >= log.length) {
      log.push(entry);
    }
  }

  commitIndex = Math.min(leaderCommitIndex, log.length - 1);
  raft_log("SYNC_LOG_DONE", `logLen=${log.length} commitIndex=${commitIndex}`);

  res.json({ ok: true });
});

// ── /replicate ────────────────────────────────────────────────────────────────
app.post("/replicate", async (req, res) => {
  if (state !== "leader") {
    return res.status(403).json({ error: "not leader", leaderId });
  }

  const { data } = req.body;
  const prevLogIndex = log.length - 1;
  const prevLogTerm = prevLogIndex >= 0 ? log[prevLogIndex].term : 0;
  const entry = { term: currentTerm, index: log.length, data };

  log.push(entry);
  raft_log("REPLICATE_START", `index=${entry.index}`);

  let acks = 1; // leader counts itself

  const replicateResults = await Promise.all(
    PEERS.map(async (peer) => {
      const r = await rpc(peer, "/append-entries", {
        term: currentTerm,
        leaderId: ID,
        entry,
        prevLogIndex,
        prevLogTerm,
      });
      return { peer, result: r };
    })
  );

  for (const { peer, result: r } of replicateResults) {
    if (!r) continue;

    if (r.term > currentTerm) {
      stepDown(r.term);
      log.pop();
      return res.status(503).json({ error: "stepped down" });
    }

    if (r.success) {
      acks++;
    } else if (r.logLength !== undefined) {
      // ── Catch-up: follower is behind, push missing entries to it ──────────
      const missingEntries = log.slice(r.logLength);
      raft_log("CATCHUP_PUSH", `peer=${peer} fromIdx=${r.logLength} count=${missingEntries.length}`);
      // Fire and forget — follower will be in sync by next round
      rpc(peer, "/sync-log", {
        entries: missingEntries,
        leaderCommitIndex: commitIndex,
      });
    }
  }

  const majority = Math.floor((PEERS.length + 1) / 2) + 1;

  if (acks >= majority) {
    commitIndex = entry.index;
    raft_log("COMMIT", `index=${commitIndex} acks=${acks}/${PEERS.length + 1}`);
    return res.json({ committed: true, entry });
  } else {
    log.pop();
    raft_log("QUORUM_FAIL", `acks=${acks} needed=${majority}`);
    return res.status(503).json({ error: "no quorum" });
  }
});

// ── /status ───────────────────────────────────────────────────────────────────
app.get("/status", (req, res) => {
  res.json({ id: ID, state, term: currentTerm, leaderId, logLength: log.length, commitIndex });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  raft_log("STARTED", `port=${PORT} peers=${PEERS.join(",")}`);
  resetElectionTimer();
});

process.on("SIGTERM", () => {
  raft_log("SHUTDOWN", "graceful SIGTERM");
  clearTimeout(electionTimer);
  clearInterval(heartbeatTimer);
  process.exit(0);
});
// hot-reload test
// hot-reload test
// hot-reload test
// hot-reload test
// hot-reload test
// hot-reload test
