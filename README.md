# MiniRAFT - Distributed Real-Time Drawing Board

A fault-tolerant collaborative whiteboard backed by a mini-RAFT consensus cluster.
Built with Node.js, WebSockets, Docker, and a simplified RAFT consensus protocol.

---

## Repository structure

```
miniraft/
├── docker-compose.yml        # Full cluster definition with healthchecks
├── ARCHITECTURE.md           # Protocol design, API spec, failure scenarios
├── README.md                 # This file
├── logs/
│   └── failover-demo.log     # Captured log showing live failover events
├── gateway/                  # WebSocket server - leader discovery & client broadcast
│   ├── Dockerfile
│   ├── package.json
│   └── server.js
├── replica1/                 # RAFT replica node (same code, different env vars)
│   ├── Dockerfile
│   ├── package.json
│   └── server.js
├── replica2/                 # identical to replica1
├── replica3/                 # identical to replica1
└── frontend/
    └── index.html            # Canvas UI served via nginx
```

---

## Prerequisites

- Docker Desktop (or Docker Engine + Compose plugin) v24+
- Ports 3000, 4001, 4002, 4003, 8080 must be free

---

## Starting the system

```bash
# First run - builds all images and starts all containers
docker compose up --build

# Subsequent runs (no code changes)
docker compose up

# Run in background
docker compose up -d
```

**Service port map:**

| Service   | Host port | Purpose                          |
|-----------|-----------|----------------------------------|
| frontend  | 3000      | Drawing canvas (open in browser) |
| gateway   | 8080      | WebSocket + leader routing       |
| replica1  | 4001      | RAFT replica node                |
| replica2  | 4002      | RAFT replica node                |
| replica3  | 4003      | RAFT replica node                |

Open **http://localhost:3000** in two or more browser tabs to draw collaboratively.

Check which node is the current leader:
```bash
curl http://localhost:4001/status
curl http://localhost:4002/status
curl http://localhost:4003/status
# Look for "state": "leader"
```

---

## Demo scenarios

### 1. Multi-client real-time sync
Open `http://localhost:3000` in two browser tabs side by side and draw in one tab -
strokes appear in both instantly. A third tab opened mid-session will receive the
full canvas history via the canvas replay mechanism.

### 2. Kill the leader (failover demo)

```bash
# Find the current leader first
curl -s http://localhost:4001/status | grep state

# Stop it (replace with whichever replica shows "leader")
docker stop replica2
```

Watch the browser: within ~800ms the two remaining replicas elect a new leader.
Drawing continues with zero client disconnection. The cluster sidebar in the UI
shows the new leader highlighted in green.

Restart the stopped replica:
```bash
docker start replica2
```
It rejoins as a follower, catches up all missed entries via `/sync-log`, and
participates normally. The sidebar shows it transition back to follower state.

### 3. Hot-reload a replica (zero-downtime)

```bash
# Touch any file inside a replica folder - nodemon detects the change,
# sends SIGTERM, and restarts the process inside the running container
echo " " >> replica1/server.js
```

The container restarts in-place (no image rebuild needed). The restarted node
catches up via the leader's `/sync-log` endpoint. Clients never disconnect.

### 4. Stress / chaotic conditions

```bash
# Kill two replicas in quick succession
docker stop replica1 && sleep 0.5 && docker stop replica2

# Bring them back
docker start replica1 && sleep 0.3 && docker start replica2
```

The system recovers as long as at least one replica survives. All committed
strokes are preserved - the catch-up protocol restores full consistency.

---

## Observability - reading logs

```bash
# Live log stream for all services
docker compose logs -f

# Per-replica (structured JSON to stdout)
docker logs -f replica1
docker logs -f replica2
docker logs -f replica3

# Gateway logs
docker logs -f gateway
```

Key log events to watch for during a failover demo:

| Event            | Meaning                                            |
|------------------|----------------------------------------------------|
| `ELECTION_START` | Node timed out waiting for heartbeat               |
| `BECAME_LEADER`  | Node won the election                              |
| `STEP_DOWN`      | Node saw a higher term, reverted to follower       |
| `COMMIT`         | Entry replicated to majority, marked committed     |
| `SYNC_LOG_RECV`  | Restarted node receiving catch-up entries          |
| `CATCHUP_PUSH`   | Leader pushing missing entries to lagging follower |
| `QUEUE_FLUSH`    | Gateway replaying strokes buffered during election |

A sample log from a real failover run is in `logs/failover-demo.log`.

---

## Stopping

```bash
docker compose down        # stop and remove containers
docker compose down -v     # also remove volumes
```

---

## Mini-RAFT protocol summary

| Parameter          | Value                       |
|--------------------|-----------------------------|
| Election timeout   | 500-800ms (random per node) |
| Heartbeat interval | 150ms                       |
| Majority required  | >=2 of 3 nodes              |
| Log entry format   | `{ term, index, data }`     |

RPC endpoints on each replica:
`/request-vote`, `/append-entries`, `/heartbeat`, `/sync-log`, `/replicate`, `/status`

See `ARCHITECTURE.md` for full protocol design, state machine, API specification,
and failure scenario analysis.