// ── Canvas setup ──────────────────────────────────────────────────────────────
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");

// Local vector store — all committed strokes kept so resize re-renders correctly.
// Size is stored normalised as a fraction of a 1000px reference width so it
// scales proportionally on any screen size.
const localStrokes = [];

function redrawAll() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (const s of localStrokes) {
    renderLine(
      s.x1 * canvas.width,  s.y1 * canvas.height,
      s.x2 * canvas.width,  s.y2 * canvas.height,
      s.color,
      s.size * canvas.width / 1000
    );
  }
}

function resizeCanvas() {
  const wrap = document.getElementById("canvas-wrap");
  canvas.width  = wrap.clientWidth;
  canvas.height = wrap.clientHeight;
  redrawAll();
}
resizeCanvas();
window.addEventListener("resize", resizeCanvas);

// ── Tools ─────────────────────────────────────────────────────────────────────
const colorEl = document.getElementById("color");
const sizeEl = document.getElementById("size");
const sizeVal = document.getElementById("size-val");
const eraserBtn = document.getElementById("eraser-btn");
const clearBtn = document.getElementById("clear-btn");

let erasing = false;
sizeEl.addEventListener("input", () => { sizeVal.textContent = sizeEl.value; });
eraserBtn.addEventListener("click", () => {
  erasing = !erasing;
  eraserBtn.classList.toggle("active", erasing);
  eraserBtn.textContent = erasing ? "Pen" : "Eraser";
});
clearBtn.addEventListener("click", () => {
  // Don't clear locally — wait for the server to broadcast it back,
  // so all clients clear in sync.
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "clear" }));
  }
});

// ── Drawing ───────────────────────────────────────────────────────────────────
let drawing = false, lx = 0, ly = 0;

function pos(e) {
  const r = canvas.getBoundingClientRect();
  const src = e.touches ? e.touches[0] : e;
  return [(src.clientX - r.left) / r.width * canvas.width,
          (src.clientY - r.top) / r.height * canvas.height];
}

canvas.addEventListener("mousedown", (e) => { drawing = true; [lx, ly] = pos(e); });
canvas.addEventListener("touchstart", (e) => { e.preventDefault(); drawing = true; [lx, ly] = pos(e); }, { passive: false });
canvas.addEventListener("mousemove", (e) => { if (drawing) onDraw(e); });
canvas.addEventListener("touchmove", (e) => { e.preventDefault(); if (drawing) onDraw(e); }, { passive: false });
["mouseup","mouseleave","touchend"].forEach(ev => canvas.addEventListener(ev, () => { drawing = false; }));

function onDraw(e) {
  const [x, y] = pos(e);
  const color = erasing ? "#ffffff" : colorEl.value;
  const size = +sizeEl.value;
  renderLine(lx, ly, x, y, color, size);
  // Normalise size relative to 1000px reference width so it looks consistent
  // on any canvas size (replay, resize, different screen widths)
  const normSize = size / canvas.width * 1000;
  sendStroke({ x1: lx/canvas.width, y1: ly/canvas.height,
               x2: x/canvas.width,  y2: y/canvas.height, color, size: normSize });
  lx = x; ly = y;
}

function renderLine(x1, y1, x2, y2, color, size) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.strokeStyle = color;
  ctx.lineWidth = size;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.stroke();
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
const wsDot = document.getElementById("ws-dot");
const wsLabel = document.getElementById("ws-label");
let ws, strokeCount = 0, electionCount = 0;
let prevLeader = null;

function connect() {
  ws = new WebSocket(`ws://${location.hostname}:8080`);

  ws.onopen = () => {
    wsDot.className = "dot ok";
    wsLabel.textContent = "Connected";
    addEvent("Connected to gateway", "ok");
  };

  ws.onclose = () => {
    wsDot.className = "dot err";
    wsLabel.textContent = "Reconnecting…";
    addEvent("Gateway disconnected — retrying", "err");
    setTimeout(connect, 1000);
  };

  ws.onerror = () => { wsDot.className = "dot err"; };

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);

    if (msg.type === "stroke") {
      const s = msg.data;
      localStrokes.push(s); // store in local vector history
      renderLine(s.x1*canvas.width, s.y1*canvas.height,
                 s.x2*canvas.width, s.y2*canvas.height,
                 s.color, s.size * canvas.width / 1000);
      strokeCount++;
      document.getElementById("stat-strokes").textContent = strokeCount;
      const fill = document.getElementById("stroke-fill");
      fill.style.width = Math.min(100, (strokeCount % 50) * 2) + "%";
    }

    // Replay committed canvas history when joining mid-session
    if (msg.type === "canvas_replay") {
      localStrokes.length = 0;
      for (const s of msg.strokes) localStrokes.push(s);
      redrawAll(); // uses localStrokes + current canvas dimensions
      strokeCount = msg.strokes.length;
      document.getElementById("stat-strokes").textContent = strokeCount;
      addEvent(`Canvas replayed — ${msg.strokes.length} strokes loaded`, "ok");
    }

    if (msg.type === "clear") {
      localStrokes.length = 0;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      strokeCount = 0;
      document.getElementById("stat-strokes").textContent = 0;
      document.getElementById("stroke-fill").style.width = "0%";
      addEvent("Canvas cleared by a user", "warn");
    }

    if (msg.type === "cluster_state") {
      updateClusterUI(msg.statuses);
    }

    if (msg.type === "error") {
      addEvent("Error: " + msg.message, "err");
    }
  };
}

function sendStroke(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "stroke", data }));
  }
}

// ── Cluster UI ────────────────────────────────────────────────────────────────
function updateClusterUI(statuses) {
  const nodesEl = document.getElementById("nodes");
  const termEl = document.getElementById("stat-term");
  const leaderEl = document.getElementById("stat-leader");

  nodesEl.innerHTML = "";

  let maxTerm = 0;
  let currentLeader = null;

  for (const s of statuses) {
    const stateClass = s.state === "leader" ? "leader"
                     : s.state === "candidate" ? "candidate"
                     : s.state === "follower" ? "follower"
                     : "unreachable";

    const card = document.createElement("div");
    card.className = `node-card ${stateClass}`;
    card.innerHTML = `
      <div class="node-top">
        <span class="node-id">${s.id || s.replica.split("//")[1]}</span>
        <span class="node-state">${s.state || "unreachable"}</span>
      </div>
      <div class="node-meta">
        <span><span class="k">term</span> ${s.term ?? "—"}</span>
        <span><span class="k">log</span> ${s.logLength ?? "—"}</span>
        <span><span class="k">commit</span> ${s.commitIndex ?? "—"}</span>
      </div>`;
    nodesEl.appendChild(card);

    if (s.term > maxTerm) maxTerm = s.term;
    if (s.state === "leader") currentLeader = s.id;
  }

  termEl.textContent = maxTerm || "—";
  leaderEl.textContent = currentLeader || "electing…";

  // Detect leader change
  if (currentLeader && currentLeader !== prevLeader) {
    if (prevLeader !== null) {
      electionCount++;
      document.getElementById("stat-elections").textContent = electionCount;
      addEvent(`New leader elected: ${currentLeader} (term ${maxTerm})`, "ok");
    }
    prevLeader = currentLeader;
  }

  if (!currentLeader && prevLeader !== null) {
    addEvent("Leader lost — election in progress…", "warn");
    prevLeader = null;
  }
}

// ── Event log ─────────────────────────────────────────────────────────────────
const eventLog = document.getElementById("event-log");

function addEvent(msg, type = "") {
  const div = document.createElement("div");
  div.className = `ev ${type}`;
  const t = new Date().toLocaleTimeString("en", { hour12: false });
  div.innerHTML = `<span class="tag">[${t}]</span>${msg}`;
  eventLog.prepend(div);
  while (eventLog.children.length > 40) eventLog.removeChild(eventLog.lastChild);
}

connect();
