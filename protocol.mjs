// Pure routing rules for lead-wake. Keep wakeableBrokerError in sync with
// apply-grok-fallback.py, which patches the same check into grok-edge.ts.

export const PEER_ID = /^[a-zA-Z0-9_-]{3,64}$/;
export const THREAD_ID = /^(?:mcp:)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TERMINAL = new Set(["completed", "interrupted", "failed", "cancelled", "rolled_back"]);
export const MAX_MESSAGE = 8000;

export function wakeableBrokerError(error) {
  const text = String(error ?? "");
  return text === "peer not found or stale"
    || /^Peer \S+ not found$/.test(text)
    || /^Peer \S+ is stale$/.test(text);
}

export function loadRoutes(text) {
  const data = JSON.parse(text);
  const table = data.routes ?? data;
  if (!table || typeof table !== "object" || Array.isArray(table)) throw Error("routes file must be an object");
  const routes = {};
  for (const [id, route] of Object.entries(table)) {
    if (!PEER_ID.test(id)) throw Error(`bad peer id in routes: ${id}`);
    if (!route || !THREAD_ID.test(route.threadId ?? "")) throw Error(`bad thread id for ${id}`);
    routes[id] = { threadId: route.threadId, title: typeof route.title === "string" ? route.title : "" };
  }
  return routes;
}

export function parseWakeText(text) {
  let to_id = null, kind = null, header = true;
  const body = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (header && !line.trim()) continue;
    const match = header && /^(to|kind):\s*(\S+)\s*$/i.exec(line);
    if (match) {
      if (match[1].toLowerCase() === "to") to_id = match[2];
      else kind = match[2].toLowerCase();
      continue;
    }
    header = false;
    body.push(line);
  }
  return { to_id, kind, message: body.join("\n").trim() };
}

export function threadText({ from_id, to_id, kind, message }) {
  const who = PEER_ID.test(from_id ?? "") ? from_id : "unknown";
  const how = kind && /^(notification|request|reply)$/.test(kind) ? ` (${kind})` : "";
  return [
    `Peers message for ${to_id} from ${who}${how}.`,
    "The seat was not on peers, so lead-wake delivered this into the T3 thread.",
    "",
    message.trim(),
  ].join("\n");
}

export function planWake({ routes, to_id, message, from_id, kind }) {
  if (!PEER_ID.test(to_id ?? "")) return { error: "to_id must match [a-zA-Z0-9_-]{3,64}" };
  const text = String(message ?? "").trim();
  if (!text) return { error: "message is empty" };
  if (text.length > MAX_MESSAGE) return { error: "message is too long" };
  const route = routes?.[to_id];
  if (!route) return { error: `no wake route for ${to_id}` };
  return { threadId: route.threadId, text: threadText({ from_id, to_id, kind, message: text }) };
}

export function latestRun(projection) {
  return [...(projection?.runs ?? [])].sort((a, b) => (b.ordinal ?? 0) - (a.ordinal ?? 0))[0] ?? null;
}

// auto only: start an idle thread, or queue behind a live run. Never steer or restart.
export function chooseAutoMode(run) {
  return run && !TERMINAL.has(run.status) ? { type: "queue_after_active" } : { type: "start_immediately" };
}
