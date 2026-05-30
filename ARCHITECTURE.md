# Architecture Document — Distributed Real-Time Drawing Board with Mini-RAFT

## 1. Cluster Diagram

```
Browsers (multiple tabs / users)
        │  WebSocket  ws://localhost:8080
        ▼
┌──────────────────────────────────┐
│          GATEWAY  (:8080)        │
│  - Manages all WebSocket clients │
│  - Polls replicas every 200ms    │
│  - Forwards strokes to leader    │
│  - Broadcasts committed strokes  │
│  - Pushes cluster state to UI    │
└────────────┬─────────────────────┘
             │  POST /replicate  (HTTP)
             ▼
    ┌─────────────────┐
    │   LEADER        │◄──────────────────────┐
    │  (any replica)  │  POST /request-vote    │
    └────────┬────────┘  POST /heartbeat       │
             │                                 │
   POST /append-entries                        │
   POST /sync-log (catch-up)                   │
    ┌────────┴──────────────────┐              │
    ▼                           ▼              │
┌──────────┐            ┌──────────┐           │
│ Follower │            │ Follower │───────────┘
│ replica  │            │ replica  │
└──────────┘            └──────────┘

Docker network: raft-net (bridge)
Ports: replica1:4001  replica2:4002  replica3:4003  gateway:8080  frontend:3000
```

---

## 2. Mini-RAFT Protocol Design

### 2.1 Node States

| State     | Behaviour |
|-----------|-----------|
| Follower  | Waits for heartbeats. Election timeout 500–800ms. If missed → becomes Candidate. |
| Candidate | Increments term, votes for self, sends RequestVote to all peers. |
| Leader    | Sends Heartbeat every 150ms. Handles all writes (/replicate). Replicates via AppendEntries. |

### 2.2 In-Memory State Per Node

| Variable      | Type    | Purpose |
|---------------|---------|---------|
| `currentTerm` | int     | Monotonically increasing election term |
| `votedFor`    | string  | Candidate this node voted for in currentTerm |
| `log[]`       | array   | `{ term, index, data }` — append-only stroke log |
| `commitIndex` | int     | Index of last durably committed entry |
| `state`       | string  | "follower" / "candidate" / "leader" |
| `leaderId`    | string  | Known current leader ID |

> **Note on persistence:** All state above is held in memory. The stroke log is not written to disk. On a clean restart, a node begins with an empty log and term 0, then restores full state via the catch-up protocol (the leader pushes all committed entries via `/sync-log`). A production system would persist `currentTerm`, `votedFor`, and `log[]` to a write-ahead log on disk to survive crash-restarts without needing a leader to be alive. This is a known simplification of the spec.

---

## 3. State Transition Diagram

```
          election timeout fires
  ┌───────────────────────────────────────┐
  │                                       │
  ▼                                       │
FOLLOWER ──────────────────────────► CANDIDATE
  ▲                                       │
  │  higher term seen in any message      │  receives majority votes (≥2 of 3)
  │  OR valid heartbeat received          │
  │                                       ▼
  └────────────────────────────────── LEADER
         higher term discovered (step down)
```

**All rules:**
- Any state → Follower: any message with `term > currentTerm`
- Follower → Candidate: election timeout (500–800ms random) fires with no heartbeat
- Candidate → Candidate (retry): split vote — restart with new timeout
- Candidate → Leader: receives ≥2 votes (majority of 3-node cluster)
- Leader → Follower: receives message from higher-term node

---

## 4. API Definition

### Replica Endpoints

#### `POST /request-vote`
Candidate requests a vote.

**Request:**
```json
{ "term": 3, "candidateId": "replica2", "lastLogIndex": 5, "lastLogTerm": 2 }
```
**Response:**
```json
{ "term": 3, "voteGranted": true }
```
Vote granted if: `term >= currentTerm` AND candidate log is at least as up-to-date AND node hasn't voted for someone else this term.

---

#### `POST /heartbeat`
Leader sends every 150ms to assert authority and reset follower timers.

**Request:**
```json
{ "term": 3, "leaderId": "replica2" }
```
**Response:**
```json
{ "term": 3 }
```

---

#### `POST /append-entries`
Leader replicates a single log entry to a follower.

**Request:**
```json
{
  "term": 3,
  "leaderId": "replica2",
  "prevLogIndex": 5,
  "prevLogTerm": 2,
  "entry": { "term": 3, "index": 6, "data": { "x1": 0.1, "y1": 0.2, "x2": 0.15, "y2": 0.25, "color": "#000", "size": 4 } }
}
```
**Response (success):**
```json
{ "success": true, "term": 3 }
```
**Response (log mismatch — follower needs catch-up):**
```json
{ "success": false, "logLength": 3, "term": 3 }
```
The `logLength` field tells the leader exactly where the follower's log ends, so the leader knows which entries to push via `/sync-log`.

---

#### `POST /sync-log`
Leader PUSHES missing entries to a lagging follower (catch-up protocol).

**Request (sent BY leader TO lagging follower):**
```json
{
  "entries": [
    { "term": 2, "index": 3, "data": {...} },
    { "term": 3, "index": 4, "data": {...} }
  ],
  "leaderCommitIndex": 6
}
```
**Response:**
```json
{ "ok": true }
```

**Catch-up flow:**
1. Restarted follower starts with empty log.
2. Leader sends AppendEntries → prevLogIndex check fails → follower responds `{ success: false, logLength: 0 }`.
3. Leader slices its own log from `logLength` onward → calls `/sync-log` on the follower.
4. Follower appends all missing entries, updates `commitIndex`.
5. Follower participates normally from next round.

---

#### `POST /replicate`
Gateway calls this on the leader to submit a new stroke.

**Request:**
```json
{ "data": { "x1": 0.1, "y1": 0.2, "x2": 0.15, "y2": 0.25, "color": "#000000", "size": 4 } }
```
**Response (committed — ≥2 acks):**
```json
{ "committed": true, "entry": { "term": 3, "index": 6, "data": {...} } }
```
**Response (not leader — 403):**
```json
{ "error": "not leader", "leaderId": "replica1" }
```
**Response (no quorum — 503):**
```json
{ "error": "no quorum" }
```

---

#### `GET /status`
Returns current node state. Polled by gateway every 200ms for leader discovery.

**Response:**
```json
{ "id": "replica1", "state": "leader", "term": 3, "leaderId": "replica1", "logLength": 12, "commitIndex": 11 }
```

---

### Gateway Endpoints

#### `GET /status`
```json
{ "leader": "http://replica1:4001", "leaderInfo": {...}, "clients": 3 }
```

#### WebSocket `ws://localhost:8080`

**Client → Gateway (draw stroke):**
```json
{ "type": "stroke", "data": { "x1": 0.1, "y1": 0.2, "x2": 0.15, "y2": 0.25, "color": "#000", "size": 4 } }
```
**Gateway → All Clients (committed stroke):**
```json
{ "type": "stroke", "data": { ... } }
```
**Gateway → All Clients (cluster state — every 200ms):**
```json
{ "type": "cluster_state", "statuses": [ { "id": "replica1", "state": "leader", "term": 3, ... }, ... ] }
```

---

## 5. Failure Handling Design

### 5.1 Leader Crash
- Followers detect missed heartbeats after 500–800ms timeout.
- First follower to time out starts election for `term+1`.
- With 2 nodes remaining, majority (≥2) is achievable.
- New leader is elected. Gateway discovers it within the next 200ms poll.
- Drawing resumes. Clients never disconnect (WebSocket stays to gateway).
- **No committed entries are lost** — followers already have them.

### 5.2 Follower Crash and Restart
- System continues: leader + 1 remaining follower = quorum still achieved.
- Restarted node begins as Follower, empty log.
- On first AppendEntries: prevLogIndex mismatch → responds `{ logLength: 0 }`.
- Leader detects this → calls /sync-log on the follower with all missing entries.
- Follower catches up, participates normally.

### 5.3 Hot-Reload (File Edit → Container Restart)
- nodemon detects file change → sends SIGTERM → process exits cleanly.
- Container restarts (bind mount + nodemon = zero rebuild needed).
- Same catch-up flow as restart above.
- Gateway keeps serving other clients throughout; no WebSocket drops.

### 5.4 Split Vote
- Two candidates start elections simultaneously.
- Neither gets majority — both revert to Follower.
- Staggered random timeouts (500–800ms) ensure one starts next election first.
- Resolved quickly — rarely takes more than one retry round.

### 5.5 Stale Leader (Network Delay / Old Leader Returns)
- Stale leader's term is lower than current term.
- Any node that receives a heartbeat/vote-request with `term < currentTerm` rejects it.
- Stale leader receives a response with higher term → steps down immediately.
- **Only one leader possible per term** (higher-term always wins).

### 5.6 Quorum Loss (2 Replicas Down)
- Leader cannot get majority acks → entries not committed → not broadcast.
- System becomes unavailable for writes (correct — safer than split-brain).
- When a replica recovers → quorum restored → system resumes.

---

## 6. Failure Scenarios List (Week 1 Deliverable)

| Scenario | Expected Behaviour |
|---|---|
| Kill the leader replica | Remaining 2 elect new leader within ~800ms; drawing resumes |
| Kill a follower replica | System continues; leader + 1 follower still = majority |
| Kill 2 replicas simultaneously | System unavailable (no quorum); recovers when one restarts |
| Edit a replica file (hot-reload) | Container restarts; catches up via /sync-log; zero client disconnect |
| Kill and restart leader | Returns as follower; catches up; old leader is now follower |
| Rapid kill/restart cycles | RAFT elections stabilise; no data loss of committed entries |
| Multiple simultaneous clients | All see identical canvas via committed-only broadcast |
| Old leader reconnects with stale term | Immediately steps down when it sees higher term in any response |

---

## 7. Stroke Coordinate Encoding

All strokes are stored as **normalised coordinates** in range [0, 1]:

```
x_normalised = x_pixel / canvas.width
y_normalised = y_pixel / canvas.height
```

On receive, clients scale back to their own canvas dimensions. This guarantees identical visual output across all clients regardless of window size or device pixel ratio.

---

## 8. Observability

Every replica emits structured JSON logs to stdout:

```json
{ "ts": "2026-04-08T10:00:01.234Z", "id": "replica1", "term": 3, "state": "leader", "event": "COMMIT", "detail": "index=6 acks=3/3" }
```

Event types logged: `STARTED`, `ELECTION_START`, `VOTES_RECEIVED`, `BECAME_LEADER`, `STEP_DOWN`, `VOTE_GRANTED`, `VOTE_DENIED`, `SPLIT_VOTE`, `HEARTBEAT_NEW_TERM`, `APPEND_REJECTED`, `LOG_MISMATCH`, `ENTRY_COMMITTED`, `SYNC_LOG_RECV`, `SYNC_LOG_DONE`, `REPLICATE_START`, `CATCHUP_PUSH`, `COMMIT`, `QUORUM_FAIL`, `SHUTDOWN`.

View live with:
```bash
docker logs -f replica1
docker logs -f replica2
docker logs -f replica3
```