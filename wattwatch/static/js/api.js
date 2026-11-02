// Tiny API client. Mutating requests carry the per-launch token (CSRF protection).
const TOKEN = document.querySelector('meta[name="ww-token"]')?.content || "";

export async function get(path) {
  const r = await fetch(path, { cache: "no-store" });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

export async function post(path, body = {}) {
  const r = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-WattWatch-Token": TOKEN },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.detail || data.error || `${path}: ${r.status}`);
  return data;
}

export async function del(path) {
  const r = await fetch(path, { method: "DELETE", headers: { "X-WattWatch-Token": TOKEN } });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

/** Live feed: WebSocket with automatic fallback to 1 s polling. */
export function live(onData, onState) {
  let ws, pollTimer, retry = 0;
  const poll = () => {
    clearInterval(pollTimer);
    pollTimer = setInterval(() => get("/api/live").then(onData).catch(() => onState?.("offline")), 1000);
  };
  const connect = () => {
    try {
      ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
    } catch {
      poll();
      return;
    }
    ws.onopen = () => { retry = 0; clearInterval(pollTimer); onState?.("live"); };
    ws.onmessage = (e) => onData(JSON.parse(e.data));
    ws.onclose = () => {
      onState?.("reconnecting");
      poll();
      setTimeout(connect, Math.min(15000, 1000 * 2 ** retry++));
    };
  };
  connect();
}
