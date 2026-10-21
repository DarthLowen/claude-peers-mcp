// Access view: sign in with a claude-peers token, then manage users, channels
// and grants (admins) or see your own channel (everyone else). The token lives
// in sessionStorage and travels only in the X-Peers-Token header.

const TOKEN_KEY = "claudePeersSessionToken";
const apiBase = localStorage.getItem("claudePeersApiBase") || window.CLAUDE_PEERS_API_BASE || "";

const state = {
  me: null,
  publicBrokerUrl: "",
  users: [],
  channels: [],
  tokens: [],
  peers: [],
  selectedUser: null,
};

const $ = (id) => document.querySelector(`#${id}`);
const els = {
  view: $("view-access"),
  token: $("session-token"),
  signIn: $("sign-in"),
  signOut: $("sign-out"),
  whoami: $("whoami"),
  status: $("access-status"),
  adminArea: $("admin-area"),
  memberArea: $("member-area"),
  users: $("users"),
  userCount: $("user-count"),
  newUser: $("new-user"),
  newUserAdmin: $("new-user-admin"),
  addUser: $("add-user"),
  channels: $("channels"),
  channelCount: $("channel-count"),
  newChannel: $("new-channel"),
  addChannel: $("add-channel"),
  grants: $("grants"),
  grantsUser: $("grants-user"),
  peerChannel: $("peer-channel"),
  peers: $("access-peers"),
  memberTitle: $("member-title"),
  memberCount: $("member-count"),
  memberPeers: $("member-peers"),
  reveal: $("reveal"),
  revealTitle: $("reveal-title"),
  revealToken: $("reveal-token"),
  revealConfig: $("reveal-config"),
  revealCopy: $("reveal-copy"),
  revealClose: $("reveal-close"),
};

function sessionToken() {
  try {
    return sessionStorage.getItem(TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

function setSessionToken(value) {
  try {
    if (value) sessionStorage.setItem(TOKEN_KEY, value);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage blocked: the token only lasts until reload.
  }
  memoryToken = value;
}

let memoryToken = sessionToken();

function setStatus(value) {
  els.status.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

async function session(route, body = {}) {
  const res = await fetch(`${apiBase}/api/session/${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Peers-Token": memoryToken },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status}`);
  return data;
}

const admin = (route, body) => session(`admin/${route}`, body);

function lastSeenLabel(value) {
  if (!value) return "never";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString([], { dateStyle: "short", timeStyle: "medium" });
}

function cell(text, className) {
  const td = document.createElement("td");
  td.textContent = text ?? "";
  if (className) td.className = className;
  return td;
}

function button(label, onClick, className) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  if (className) b.className = className;
  b.addEventListener("click", (event) => {
    event.stopPropagation();
    Promise.resolve(onClick()).catch((e) => setStatus(e.message));
  });
  return b;
}

function actions(...buttons) {
  const td = document.createElement("td");
  const row = document.createElement("div");
  row.className = "row";
  row.append(...buttons);
  td.append(row);
  return td;
}

function mcpServersBlock(channel, token) {
  const name = channel === "default" ? "claude-peers" : `claude-peers-${channel}`;
  const env = {
    CLAUDE_PEERS_BROKER_URL: state.publicBrokerUrl,
    CLAUDE_PEERS_TOKEN: token,
    CLAUDE_PEERS_MACHINE: "<this-machine-name>",
  };
  if (channel !== "default") env.CLAUDE_PEERS_LABEL = channel;
  return JSON.stringify({
    mcpServers: { [name]: { type: "stdio", command: "bun", args: ["/path/to/claude-peers-mcp/server.ts"], env } },
  }, null, 2);
}

function showToken(grant) {
  els.revealTitle.textContent = `Token for ${grant.user} in ${grant.channel}`;
  els.revealToken.value = grant.token;
  els.revealConfig.value = mcpServersBlock(grant.channel, grant.token);
  els.reveal.showModal();
}

// Do not leave the secret sitting in the DOM once the dialog closes.
function clearReveal() {
  els.revealToken.value = "";
  els.revealConfig.value = "";
}

function renderUsers() {
  els.userCount.textContent = String(state.users.length);
  els.users.replaceChildren();
  for (const user of state.users) {
    const tr = document.createElement("tr");
    tr.className = "clickable";
    if (state.selectedUser === user.name) tr.classList.add("selected");
    const role = [user.is_admin ? "admin" : "user", user.disabled ? "disabled" : "", user.bootstrap ? "bootstrap" : ""].filter(Boolean).join(", ");
    const grants = state.tokens.filter((t) => t.user === user.name).length;
    const controls = user.bootstrap ? [] : [
      button(user.is_admin ? "Unset admin" : "Set admin", () => mutate("update-user", { name: user.name, is_admin: !user.is_admin })),
      button(user.disabled ? "Enable" : "Disable", () => mutate("update-user", { name: user.name, disabled: !user.disabled })),
      button("Remove", () => confirm(`Remove ${user.name}, all its tokens and peers?`) && mutate("delete-user", { name: user.name }), "danger"),
    ];
    tr.append(cell(user.name), cell(role), cell(String(grants)), actions(...controls));
    tr.addEventListener("click", () => {
      state.selectedUser = user.name;
      renderUsers();
      renderGrants();
    });
    els.users.append(tr);
  }
}

function renderChannels() {
  els.channelCount.textContent = String(state.channels.length);
  els.channels.replaceChildren();
  const filter = els.peerChannel.value;
  els.peerChannel.replaceChildren(new Option("all channels", ""));
  for (const channel of state.channels) {
    const tr = document.createElement("tr");
    const controls = channel.name === "default" ? [] : [
      button("Remove", () => confirm(`Remove channel ${channel.name}? Its tokens are revoked and its peers dropped.`) && mutate("delete-channel", { name: channel.name }), "danger"),
    ];
    tr.append(cell(channel.name), cell(String(channel.peers)), cell(String(channel.tokens)), actions(...controls));
    els.channels.append(tr);
    els.peerChannel.append(new Option(channel.name, channel.name));
  }
  els.peerChannel.value = state.channels.some((c) => c.name === filter) ? filter : "";
}

function renderGrants() {
  els.grants.replaceChildren();
  const user = state.selectedUser;
  els.grantsUser.textContent = user || "select a user";
  if (!user) return;
  for (const channel of state.channels) {
    const grant = state.tokens.find((t) => t.user === user && t.channel === channel.name);
    const tr = document.createElement("tr");
    const body = { user, channel: channel.name };
    const controls = grant
      ? [
          button("Reissue", async () => showToken(await mutate("reissue", body))),
          button("Revoke", () => confirm(`Revoke ${user}'s token for ${channel.name}?`) && mutate("revoke", body), "danger"),
        ]
      : [button("Grant", async () => showToken(await mutate("grant", body)))];
    tr.append(
      cell(channel.name),
      cell(grant ? lastSeenLabel(grant.created_at) : "no token"),
      cell(grant ? lastSeenLabel(grant.last_used_at) : ""),
      actions(...controls),
    );
    els.grants.append(tr);
  }
}

function renderPeers() {
  els.peers.replaceChildren();
  const filter = els.peerChannel.value;
  for (const peer of state.peers.filter((p) => !filter || p.channel === filter)) {
    const tr = document.createElement("tr");
    tr.title = peer.summary || "";
    tr.append(cell(peer.nickname || peer.id), cell(peer.channel), cell(peer.user || "(legacy)"), cell(peer.machine), cell(lastSeenLabel(peer.last_seen)));
    els.peers.append(tr);
  }
}

function renderMember(peers) {
  els.memberTitle.textContent = `Peers in ${state.me.channel}`;
  els.memberCount.textContent = String(peers.length);
  els.memberPeers.replaceChildren();
  for (const peer of peers) {
    const tr = document.createElement("tr");
    tr.append(cell(peer.nickname || "(none)"), cell(peer.id, "mono"), cell(peer.machine), cell(peer.summary), cell(lastSeenLabel(peer.last_seen)));
    els.memberPeers.append(tr);
  }
}

async function mutate(route, body) {
  const result = await admin(route, body);
  setStatus(route === "grant" || route === "reissue" ? `${route}: ${result.user} in ${result.channel}` : { [route]: result });
  await refreshAccess();
  return result;
}

async function refreshAccess() {
  if (!memoryToken) {
    state.me = null;
    renderSignedOut();
    return;
  }
  const [me, health] = await Promise.all([session("whoami"), fetch(`${apiBase}/api/health`).then((r) => r.json())]);
  state.me = me;
  state.publicBrokerUrl = health.public_broker_url || health.broker_url || "";
  els.whoami.textContent = `${me.user} · ${me.channel}${me.is_admin ? " · admin" : ""}`;
  els.token.classList.add("hidden");
  els.signIn.classList.add("hidden");
  els.signOut.classList.remove("hidden");
  els.adminArea.classList.toggle("hidden", !me.is_admin);
  els.memberArea.classList.toggle("hidden", me.is_admin);
  if (!me.is_admin) {
    renderMember(await session("peers"));
    return;
  }
  const [users, channels, tokens, peers] = await Promise.all([
    admin("list-users"), admin("list-channels"), admin("list-tokens"), admin("list-peers"),
  ]);
  Object.assign(state, { users, channels, tokens, peers });
  if (state.selectedUser && !users.some((u) => u.name === state.selectedUser)) state.selectedUser = null;
  renderChannels();
  renderUsers();
  renderGrants();
  renderPeers();
}

function renderSignedOut() {
  els.whoami.textContent = "";
  els.token.classList.remove("hidden");
  els.signIn.classList.remove("hidden");
  els.signOut.classList.add("hidden");
  els.adminArea.classList.add("hidden");
  els.memberArea.classList.add("hidden");
}

els.signIn.addEventListener("click", () => {
  setSessionToken(els.token.value.trim());
  els.token.value = "";
  refreshAccess().then(() => setStatus("")).catch((e) => {
    setSessionToken("");
    renderSignedOut();
    setStatus(`Sign-in failed: ${e.message}`);
  });
});
els.token.addEventListener("keydown", (event) => {
  if (event.key === "Enter") els.signIn.click();
});
els.signOut.addEventListener("click", () => {
  setSessionToken("");
  state.me = null;
  renderSignedOut();
  setStatus("Signed out.");
});
els.addUser.addEventListener("click", () => {
  mutate("create-user", { name: els.newUser.value.trim(), is_admin: els.newUserAdmin.checked })
    .then(() => { els.newUser.value = ""; els.newUserAdmin.checked = false; })
    .catch((e) => setStatus(e.message));
});
els.addChannel.addEventListener("click", () => {
  mutate("create-channel", { name: els.newChannel.value.trim() })
    .then(() => { els.newChannel.value = ""; })
    .catch((e) => setStatus(e.message));
});
els.peerChannel.addEventListener("change", renderPeers);
els.view.addEventListener("click", () => refreshAccess().catch((e) => setStatus(e.message)));
els.revealClose.addEventListener("click", () => els.reveal.close());
els.reveal.addEventListener("close", clearReveal);
els.revealCopy.addEventListener("click", () => {
  navigator.clipboard?.writeText(els.revealConfig.value)
    .then(() => setStatus("Copied the mcpServers entry."))
    .catch(() => {
      els.revealConfig.select();
      setStatus("Clipboard unavailable; the entry is selected, copy it manually.");
    });
});

renderSignedOut();
if (memoryToken) refreshAccess().catch((e) => setStatus(e.message));
setInterval(() => {
  if (state.me && !$("access").classList.contains("hidden")) refreshAccess().catch(() => {});
}, 10000);
