// Access view. Admins log in with a username and password; the dashboard keeps
// the broker session in an HttpOnly cookie and this page never sees it. A peer
// token can be pasted for a read-only view of its own channel; that token lives
// in sessionStorage and travels only in the X-Peers-Token header.

const TOKEN_KEY = "claudePeersSessionToken";
const apiBase = localStorage.getItem("claudePeersApiBase") || window.CLAUDE_PEERS_API_BASE || "";

const state = {
  mode: null, // "admin" | "member" | null
  me: null,
  publicBrokerUrl: "",
  users: [],
  channels: [],
  tokens: [],
  peers: [],
  selectedUser: null,
  passwordUser: null,
};

const $ = (id) => document.querySelector(`#${id}`);
const els = {
  section: $("access"),
  view: $("view-access"),
  forms: $("signin-forms"),
  loginForm: $("login-form"),
  loginUser: $("login-user"),
  loginPassword: $("login-password"),
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
  passwordDialog: $("password-dialog"),
  passwordTitle: $("password-title"),
  passwordNew: $("password-new"),
  passwordRepeat: $("password-repeat"),
  passwordSave: $("password-save"),
  passwordClear: $("password-clear"),
  passwordCancel: $("password-cancel"),
};

function readToken() {
  try {
    return sessionStorage.getItem(TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

let memoryToken = readToken();

function setPeerToken(value) {
  try {
    if (value) sessionStorage.setItem(TOKEN_KEY, value);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage blocked: the token only lasts until reload.
  }
  memoryToken = value;
}

function setStatus(value) {
  els.status.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

async function call(route, body, headers) {
  const res = await fetch(`${apiBase}/api/session/${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `${res.status}`), { status: res.status });
  return data;
}

// Cookie-backed admin call; the custom header is the CSRF guard.
const adminCall = (route, body) => call(route, body, { "X-Peers-Admin": "1" });
const admin = (route, body) => adminCall(`admin/${route}`, body);
const peerCall = (route) => call(route, {}, { "X-Peers-Token": memoryToken });

function timeLabel(value) {
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

// Do not leave secrets sitting in the DOM once a dialog closes.
function clearReveal() {
  els.revealToken.value = "";
  els.revealConfig.value = "";
}

function openPassword(user) {
  state.passwordUser = user.name;
  els.passwordTitle.textContent = `Password for ${user.name}`;
  els.passwordClear.classList.toggle("hidden", !user.has_password);
  els.passwordDialog.showModal();
  els.passwordNew.focus();
}

function clearPassword() {
  els.passwordNew.value = "";
  els.passwordRepeat.value = "";
}

function renderUsers() {
  els.userCount.textContent = String(state.users.length);
  els.users.replaceChildren();
  for (const user of state.users) {
    const tr = document.createElement("tr");
    tr.className = "clickable";
    if (state.selectedUser === user.name) tr.classList.add("selected");
    const role = [
      user.is_admin ? "admin" : "user",
      user.has_password ? "password" : "",
      user.disabled ? "disabled" : "",
      user.legacy ? "legacy tokens" : "",
    ].filter(Boolean).join(", ");
    const grants = state.tokens.filter((t) => t.user === user.name).length;
    const controls = [
      ...(user.legacy ? [] : [
        button(user.is_admin ? "Unset admin" : "Set admin", () => mutate("update-user", { name: user.name, is_admin: !user.is_admin })),
        button("Set password", () => openPassword(user)),
      ]),
      button(user.disabled ? "Enable" : "Disable", () => mutate("update-user", { name: user.name, disabled: !user.disabled })),
      ...(user.legacy ? [] : [
        button("Remove", () => confirm(`Remove ${user.name}, all its tokens and peers?`) && mutate("delete-user", { name: user.name }), "danger"),
      ]),
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
      cell(grant ? timeLabel(grant.created_at) : "no token"),
      cell(grant ? timeLabel(grant.last_used_at) : ""),
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
    tr.append(cell(peer.nickname || peer.id), cell(peer.channel), cell(peer.user || "(unknown)"), cell(peer.machine), cell(timeLabel(peer.last_seen)));
    els.peers.append(tr);
  }
}

function renderMember(peers) {
  els.memberTitle.textContent = `Peers in ${state.me.channel}`;
  els.memberCount.textContent = String(peers.length);
  els.memberPeers.replaceChildren();
  for (const peer of peers) {
    const tr = document.createElement("tr");
    tr.append(cell(peer.nickname || "(none)"), cell(peer.id, "mono"), cell(peer.machine), cell(peer.summary), cell(timeLabel(peer.last_seen)));
    els.memberPeers.append(tr);
  }
}

function showSignedIn(label) {
  els.whoami.textContent = label;
  els.forms.classList.add("hidden");
  els.signOut.classList.remove("hidden");
  els.adminArea.classList.toggle("hidden", state.mode !== "admin");
  els.memberArea.classList.toggle("hidden", state.mode !== "member");
}

function renderSignedOut() {
  state.mode = null;
  state.me = null;
  els.whoami.textContent = "";
  els.forms.classList.remove("hidden");
  els.signOut.classList.add("hidden");
  els.adminArea.classList.add("hidden");
  els.memberArea.classList.add("hidden");
}

async function mutate(route, body) {
  const result = await admin(route, body);
  setStatus(route === "grant" || route === "reissue" ? `${route}: ${result.user} in ${result.channel}` : { [route]: result });
  await refreshAccess();
  return result;
}

async function loadHealth() {
  const health = await fetch(`${apiBase}/api/health`).then((r) => r.json());
  state.publicBrokerUrl = health.public_broker_url || health.broker_url || "";
}

async function refreshAdmin() {
  state.me = await admin("whoami");
  state.mode = "admin";
  showSignedIn(`${state.me.user} · admin · until ${timeLabel(state.me.expires_at)}`);
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

async function refreshMember() {
  state.me = await peerCall("whoami");
  state.mode = "member";
  showSignedIn(`${state.me.user} · ${state.me.channel} · read-only`);
  renderMember(await peerCall("peers"));
}

// Admin session first (cookie), then a pasted peer token, else signed out.
async function refreshAccess() {
  try {
    await refreshAdmin();
    return;
  } catch (e) {
    if (e.status !== 401) throw e;
  }
  if (memoryToken) {
    await refreshMember();
    return;
  }
  renderSignedOut();
}

els.loginForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const user = els.loginUser.value.trim();
  const password = els.loginPassword.value;
  els.loginPassword.value = "";
  adminCall("login", { user, password })
    .then(() => {
      setStatus("");
      return refreshAccess();
    })
    .catch((e) => setStatus(`Login failed: ${e.message}`));
});
els.signIn.addEventListener("click", () => {
  setPeerToken(els.token.value.trim());
  els.token.value = "";
  refreshMember().then(() => setStatus("")).catch((e) => {
    setPeerToken("");
    renderSignedOut();
    setStatus(`Token rejected: ${e.message}`);
  });
});
els.token.addEventListener("keydown", (event) => {
  if (event.key === "Enter") els.signIn.click();
});
els.signOut.addEventListener("click", () => {
  const wasAdmin = state.mode === "admin";
  setPeerToken("");
  renderSignedOut();
  (wasAdmin ? adminCall("logout") : Promise.resolve())
    .then(() => setStatus("Logged out."))
    .catch((e) => setStatus(e.message));
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
els.passwordSave.addEventListener("click", () => {
  if (els.passwordNew.value !== els.passwordRepeat.value) {
    setStatus("Passwords do not match.");
    return;
  }
  mutate("set-password", { name: state.passwordUser, password: els.passwordNew.value })
    .then(() => els.passwordDialog.close())
    .catch((e) => setStatus(e.message));
});
els.passwordClear.addEventListener("click", () => {
  if (!confirm(`Clear ${state.passwordUser}'s password? They will no longer be able to log in.`)) return;
  mutate("clear-password", { name: state.passwordUser })
    .then(() => els.passwordDialog.close())
    .catch((e) => setStatus(e.message));
});
els.passwordCancel.addEventListener("click", () => els.passwordDialog.close());
els.passwordDialog.addEventListener("close", clearPassword);
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
loadHealth().catch(() => {});
refreshAccess().catch((e) => setStatus(e.message));
setInterval(() => {
  const dialogOpen = els.reveal.open || els.passwordDialog.open;
  if (state.mode && !dialogOpen && !els.section.classList.contains("hidden")) refreshAccess().catch(() => {});
}, 10000);
