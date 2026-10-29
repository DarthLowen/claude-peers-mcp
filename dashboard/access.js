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
  cidrs: [],
  rejections: [],
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
  cidrs: $("cidrs"),
  cidrsUser: $("cidrs-user"),
  newCidr: $("new-cidr"),
  newCidrNote: $("new-cidr-note"),
  addCidr: $("add-cidr"),
  rejections: $("rejections"),
  clearRejections: $("clear-rejections"),
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
  els.revealTitle.textContent = `Token for ${grant.user} in ${grant.channel}${grant.label ? ` (${grant.label})` : ""}`;
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
    const ips = state.cidrs.filter((c) => c.user === user.name).length;
    const external = ips ? `external: ${ips} address${ips === 1 ? "" : "es"}` : "external access: none";
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
    tr.append(cell(user.name), cell(`${role}; ${external}`), cell(String(grants)), actions(...controls));
    tr.addEventListener("click", () => {
      state.selectedUser = user.name;
      renderUsers();
      renderGrants();
      renderCidrs();
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
    const grants = state.tokens.filter((t) => t.user === user && t.channel === channel.name);
    const grantNew = button(grants.length ? "Add device" : "Grant", async () => {
      // Each device gets its own labelled token; the first may stay unlabelled.
      const label = grants.length ? prompt(`Device label for ${user}'s new token in ${channel.name}:`) : "";
      if (label === null) return;
      try {
        showToken(await mutate("grant", { user, channel: channel.name, label: label.trim() }));
      } catch (e) {
        // The status line sits at the top of the tab, out of sight from here.
        alert(`Could not add the device: ${e.message}`);
      }
    });
    if (!grants.length) {
      const tr = document.createElement("tr");
      tr.append(cell(channel.name), cell(""), cell("no token"), cell(""), actions(grantNew));
      els.grants.append(tr);
      continue;
    }
    grants.forEach((grant, i) => {
      const tr = document.createElement("tr");
      const body = { user, channel: channel.name, label: grant.label };
      const name = grant.label || "default";
      const controls = [
        button("Reissue", async () => showToken(await mutate("reissue", body))),
        button("Revoke", () => confirm(`Revoke ${user}'s "${name}" token for ${channel.name}?`) && mutate("revoke", body), "danger"),
      ];
      if (i === grants.length - 1) controls.push(grantNew);
      tr.append(
        cell(i === 0 ? channel.name : ""),
        cell(name),
        cell(timeLabel(grant.created_at)),
        cell(timeLabel(grant.last_used_at)),
        actions(...controls),
      );
      els.grants.append(tr);
    });
  }
}

function renderCidrs() {
  els.cidrs.replaceChildren();
  const user = state.selectedUser;
  els.cidrsUser.textContent = user || "select a user";
  if (!user) return;
  const rows = state.cidrs.filter((c) => c.user === user);
  if (!rows.length) {
    const tr = document.createElement("tr");
    const td = cell("external access: none", "mono");
    td.colSpan = 4;
    tr.append(td);
    els.cidrs.append(tr);
  }
  for (const c of rows) {
    const tr = document.createElement("tr");
    tr.append(
      cell(c.cidr, "mono"),
      cell(c.note),
      cell(timeLabel(c.created_at)),
      actions(button("Remove", () => confirm(`Remove ${c.cidr} for ${user}?`) && mutate("remove-cidr", { user, cidr: c.cidr }), "danger")),
    );
    els.cidrs.append(tr);
  }
}

function renderRejections() {
  els.rejections.replaceChildren();
  for (const r of state.rejections) {
    const tr = document.createElement("tr");
    tr.title = r.reason;
    let allow;
    if (r.user) {
      allow = button(`Allow for ${r.user}`, () => mutate("add-cidr", { user: r.user, cidr: r.ip, note: "allowed from recent blocked" }));
    } else {
      // No valid token: pick the user to allow it for.
      const select = document.createElement("select");
      for (const u of state.users) select.append(new Option(u.name, u.name));
      select.addEventListener("click", (event) => event.stopPropagation());
      allow = document.createElement("span");
      allow.className = "row";
      allow.append(select, button("Allow", () => mutate("add-cidr", { user: select.value, cidr: r.ip, note: "allowed from recent blocked" })));
    }
    tr.append(cell(timeLabel(r.at)), cell(r.ip, "mono"), cell(r.user || "(no valid token)"), cell(r.route), actions(allow));
    els.rejections.append(tr);
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
  const [users, channels, tokens, peers, cidrs, rejections] = await Promise.all([
    admin("list-users"), admin("list-channels"), admin("list-tokens"), admin("list-peers"),
    admin("list-cidrs"), admin("list-rejections"),
  ]);
  Object.assign(state, { users, channels, tokens, peers, cidrs, rejections });
  if (state.selectedUser && !users.some((u) => u.name === state.selectedUser)) state.selectedUser = null;
  renderChannels();
  renderUsers();
  renderGrants();
  renderCidrs();
  renderRejections();
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
els.addCidr.addEventListener("click", () => {
  if (!state.selectedUser) {
    setStatus("Select a user first.");
    return;
  }
  mutate("add-cidr", { user: state.selectedUser, cidr: els.newCidr.value.trim(), note: els.newCidrNote.value.trim() })
    .then(() => { els.newCidr.value = ""; els.newCidrNote.value = ""; })
    .catch((e) => setStatus(e.message));
});
els.clearRejections.addEventListener("click", () => {
  mutate("clear-rejections", {}).catch((e) => setStatus(e.message));
});
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
  // Do not re-render under an open dialog or a half-used "Allow" picker.
  const picking = document.activeElement?.closest?.("#rejections");
  if (state.mode && !dialogOpen && !picking && !els.section.classList.contains("hidden")) refreshAccess().catch(() => {});
}, 10000);
