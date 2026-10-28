// Minecraft Hide and Seek: tiny sync server.
// Serves the game page and keeps one shared game state per room code.
// No dependencies, just Node's built-in http module.

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const PAGE = fs.readFileSync(path.join(__dirname, "index.html"));
const MAX_BODY = 512 * 1024;
const ROOM_IDLE_MS = 24 * 60 * 60 * 1000;

const rooms = new Map(); // code -> { v, state, clients:Set, touched }

const validRoom = (c) => /^[A-Z0-9]{4,8}$/.test(c || "");

function getRoom(code) {
  let r = rooms.get(code);
  if (!r) {
    r = { v: 0, state: null, clients: new Set(), touched: Date.now() };
    rooms.set(code, r);
  }
  r.touched = Date.now();
  return r;
}

function send(res, status, body, type = "application/json") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function broadcast(r) {
  const msg = `data: ${JSON.stringify({ v: r.v, state: r.state })}\n\n`;
  for (const res of r.clients) res.write(msg);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const code = (url.searchParams.get("room") || "").toUpperCase();

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
    return res.end(PAGE);
  }

  if (url.pathname === "/healthz") return send(res, 200, "ok", "text/plain");

  if (url.pathname.startsWith("/api/") && !validRoom(code)) {
    return send(res, 400, { error: "Room code must be 4 to 8 letters or numbers." });
  }

  // Live updates (Server-Sent Events)
  if (req.method === "GET" && url.pathname === "/api/events") {
    const r = getRoom(code);
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(`retry: 2000\n`);
    res.write(`data: ${JSON.stringify({ v: r.v, state: r.state })}\n\n`);
    r.clients.add(res);
    req.on("close", () => r.clients.delete(res));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/state") {
    const r = getRoom(code);
    return send(res, 200, { v: r.v, state: r.state });
  }

  if (req.method === "POST" && url.pathname === "/api/state") {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { send(res, 413, { error: "Too big" }); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      if (res.writableEnded) return;
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return send(res, 400, { error: "Bad JSON" }); }
      if (!body || typeof body.state !== "object" || body.state === null || Array.isArray(body.state)) {
        return send(res, 400, { error: "Missing state" });
      }
      const r = getRoom(code);
      r.v += 1;
      r.state = body.state;
      broadcast(r);
      send(res, 200, { v: r.v });
    });
    return;
  }

  send(res, 404, { error: "Not found" });
});

// Keep live connections open through proxies
setInterval(() => {
  for (const r of rooms.values()) for (const res of r.clients) res.write(": ping\n\n");
}, 20000);

// Forget rooms nobody has touched in a day
setInterval(() => {
  const now = Date.now();
  for (const [code, r] of rooms) if (!r.clients.size && now - r.touched > ROOM_IDLE_MS) rooms.delete(code);
}, 60 * 60 * 1000);

server.listen(PORT, () => console.log(`Hide and Seek server on port ${PORT}`));
