const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const REPLICAS = process.env.REPLICAS.split(",");
const PORT = 8080;

// ── Leader tracking ───────────────────────────────────────────────────────────
let currentLeader = null;
let leaderInfo = null; // full status object for broadcasting to UI

// ── Canvas replay ─────────────────────────────────────────────────────────────
// Every committed stroke is appended here so new clients can catch up instantly.
// Capped at 5000 entries to avoid unbounded memory growth in long sessions.
const MAX_HISTORY = 5000;
const committedStrokes = [];

function recordStroke(data) {
  committedStrokes.push(data);
  if (committedStrokes.length > MAX_HISTORY) {
    committedStrokes.shift();
  }
}

// ── Stroke queue during elections ────────────────────────────────────────────
// Strokes that arrive while no leader is elected are held here and flushed
// automatically once discoverLeader() finds a new leader.
const strokeQueue = []; // [ { data, senderWs } ]
const QUEUE_MAX = 200;  // safety cap — don't buffer forever

async function flushQueue() {
  if (strokeQueue.length === 0) return;
  gw_log("QUEUE_FLUSH", `flushing ${strokeQueue.length} queued strokes`);
  // Drain a snapshot so new strokes arriving during flush don't loop
  const pending = strokeQueue.splice(0, strokeQueue.length);
  for (const { data, senderWs } of pending) {
    await forwardStroke(data, senderWs);
  }
}

function gw_log(event, detail = "") {
  console.log(JSON.stringify({ ts: new Date().toISOString(), service: "gateway", event, detail }));
}

async function discoverLeader() {
  const statuses = await Promise.all(
    REPLICAS.map(async (replica) => {
      try {
        const res = await fetch(`${replica}/status`, { timeout: 500 });
        const data = await res.json();
        return { replica, ...data };
      } catch {
        return { replica, state: "unreachable" };
      }
    })
  );

  // Broadcast cluster state to all connected UI clients
  broadcastClusterState(statuses);

  const leader = statuses.find((s) => s.state === "leader");
  if (leader) {
    const leaderChanged = currentLeader !== leader.replica;
    if (leaderChanged) {
      gw_log("LEADER_CHANGED", `new leader=${leader.id} at ${leader.replica} term=${leader.term}`);
    }
    currentLeader = leader.replica;
    leaderInfo = leader;

    // Flush any strokes that queued up while there was no leader
    if (leaderChanged && strokeQueue.length > 0) {
      flushQueue(); // intentionally not awaited — runs in background
    }

    return leader.replica;
  }

  if (currentLeader !== null) {
    gw_log("NO_LEADER", "election in progress");
  }
  currentLeader = null;
  leaderInfo = null;
  return null;
}

// Poll every 200ms
setInterval(discoverLeader, 200);
discoverLeader();

// ── WebSocket clients ─────────────────────────────────────────────────────────
const clients = new Set();

function broadcastClusterState(statuses) {
  const payload = JSON.stringify({ type: "cluster_state", statuses });
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

wss.on("connection", (ws) => {
  clients.add(ws);
  gw_log("CLIENT_CONNECTED", `total=${clients.size}`);

  // Replay committed strokes to the new client
  // Send the full canvas history as a single batch so the new tab renders
  // the existing drawing before the user touches anything.
  if (committedStrokes.length > 0) {
    ws.send(JSON.stringify({ type: "canvas_replay", strokes: committedStrokes }));
    gw_log("CANVAS_REPLAY", `sent ${committedStrokes.length} strokes to new client`);
  }

  ws.on("message", async (msg) => {
    let parsed;
    try { parsed = JSON.parse(msg); } catch { return; }
    if (parsed.type === "stroke") {
      await forwardStroke(parsed.data, ws);
    } else if (parsed.type === "clear") {
      await forwardClear(ws);
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
    gw_log("CLIENT_DISCONNECTED", `total=${clients.size}`);
  });
});

// ── Stroke forwarding ─────────────────────────────────────────────────────────
async function forwardStroke(data, senderWs, retried = false) {
  let leader = currentLeader;
  if (!leader) leader = await discoverLeader();

  if (!leader) {
    // Queue the stroke instead of dropping it
    if (strokeQueue.length < QUEUE_MAX) {
      strokeQueue.push({ data, senderWs });
      gw_log("STROKE_QUEUED", `queue_size=${strokeQueue.length}`);
    } else {
      gw_log("QUEUE_FULL", "dropping stroke — queue at capacity");
      if (senderWs.readyState === WebSocket.OPEN) {
        senderWs.send(JSON.stringify({ type: "error", message: "no leader — stroke dropped (queue full)" }));
      }
    }
    return;
  }

  try {
    const res = await fetch(`${leader}/replicate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data }),
      timeout: 1000,
    });

    if (res.status === 403) {
      const body = await res.json();
      gw_log("NOT_LEADER", `redirecting, hint=${JSON.stringify(body.leaderId)}`);
      currentLeader = null;
      // Use the hint if available — find the replica URL for that leaderId
      if (body.leaderId && !retried) {
        // Array.find() doesn't work with async — use a proper async loop
        for (const r of REPLICAS) {
          try {
            const s = await fetch(`${r}/status`, { timeout: 300 });
            const d = await s.json();
            if (d.id === body.leaderId) { currentLeader = r; break; }
          } catch { /* skip unreachable */ }
        }
      }
      if (!retried) return forwardStroke(data, senderWs, true);
      return;
    }

    if (res.status === 503) { currentLeader = null; discoverLeader(); return; }
    if (!res.ok) return;

    const result = await res.json();
    if (result.committed) {
      // Record every committed stroke in history
      if (!result.entry.data.__clear) recordStroke(result.entry.data);

      const payload = JSON.stringify({ type: "stroke", data: result.entry.data });
      for (const client of clients) {
        if (client.readyState === WebSocket.OPEN) client.send(payload);
      }
    }
  } catch {
    // Leader went down
    gw_log("LEADER_UNREACHABLE", `was=${leader}`);
    currentLeader = null;
    discoverLeader();
  }
}

async function forwardClear(senderWs, retried = false) {
  let leader = currentLeader;
  if (!leader) leader = await discoverLeader();

  if (!leader) {
    if (senderWs.readyState === WebSocket.OPEN) {
      senderWs.send(JSON.stringify({ type: "error", message: "no leader — clear dropped" }));
    }
    return;
  }

  try {
    const res = await fetch(`${leader}/replicate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: { __clear: true } }),
      timeout: 1000,
    });

    if (res.status === 403) {
      const body = await res.json();
      currentLeader = null;
      if (body.leaderId && !retried) {
        for (const r of REPLICAS) {
          try {
            const s = await fetch(`${r}/status`, { timeout: 300 });
            const d = await s.json();
            if (d.id === body.leaderId) { currentLeader = r; break; }
          } catch { /* skip */ }
        }
      }
      if (!retried) return forwardClear(senderWs, true);
      return;
    }

    if (res.status === 503) { currentLeader = null; discoverLeader(); return; }
    if (!res.ok) return;

    const result = await res.json();
    if (result.committed) {
      // Wipe the in-memory stroke history so new joiners get a blank canvas
      committedStrokes.length = 0;
      gw_log("CANVAS_CLEARED", "broadcasting clear to all clients");
      const payload = JSON.stringify({ type: "clear" });
      for (const client of clients) {
        if (client.readyState === WebSocket.OPEN) client.send(payload);
      }
    }
  } catch {
    gw_log("LEADER_UNREACHABLE", `clear failed, was=${leader}`);
    currentLeader = null;
    discoverLeader();
  }
}

// ── Status endpoint ───────────────────────────────────────────────────────────
app.get("/status", (req, res) => {
  res.json({
    leader: currentLeader,
    leaderInfo,
    clients: clients.size,
    committedStrokes: committedStrokes.length, // handy for debugging
    queuedStrokes: strokeQueue.length,
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  gw_log("STARTED", `port=${PORT}`);
});