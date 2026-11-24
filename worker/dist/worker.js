// src/page.html
var page_default = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Claude Queue</title>
<link id="fav" rel="icon" href="data:,">
<style>
  :root { --bg:#16120f; --card:#211b16; --line:#3a2f26; --text:#f3ebe2; --dim:#a8998a;
          --red:#f87171; --amber:#f2a93b; --green:#6fcf97; --accent:#e07a2e; }
  * { box-sizing: border-box; }
  body { margin:0; font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif; background:var(--bg); color:var(--text); }
  main { max-width: 880px; margin: 0 auto; padding: 20px 16px 60px; }
  header { display:flex; align-items:baseline; gap:12px; flex-wrap:wrap; margin-bottom:16px; }
  h1 { font-size:22px; margin:0; }
  h1 b { color:var(--accent); }
  .meta { color:var(--dim); font-size:13px; }
  .spacer { flex:1; }
  button, .btn { font:inherit; font-size:13px; color:var(--text); background:#2c241d; border:1px solid var(--line);
                 border-radius:7px; padding:5px 10px; cursor:pointer; text-decoration:none; white-space:nowrap; }
  button:hover, .btn:hover { border-color:var(--accent); }
  h2 { font-size:13px; text-transform:uppercase; letter-spacing:.08em; color:var(--dim); margin:26px 0 8px; }
  .card { background:var(--card); border:1px solid var(--line); border-left:4px solid var(--line);
          border-radius:10px; padding:12px 14px; margin-bottom:10px; }
  .card.permission { border-left-color:var(--red); }
  .card.question   { border-left-color:var(--amber); }
  .card.done       { border-left-color:var(--green); }
  .row1 { display:flex; gap:10px; align-items:baseline; flex-wrap:wrap; }
  .proj { font-weight:600; font-size:16px; }
  .tag { font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.05em; padding:1px 7px; border-radius:20px; }
  .tag.permission { background:#4a1f1f; color:var(--red); }
  .tag.question   { background:#4a3515; color:var(--amber); }
  .tag.done       { background:#1d3a2a; color:var(--green); }
  .age { color:var(--dim); font-size:13px; }
  .age.old { color:var(--red); font-weight:600; }
  .where { color:var(--dim); font-size:12px; margin-top:2px; word-break:break-all; }
  .summary { margin:8px 0 10px; white-space:pre-wrap; word-wrap:break-word; }
  .actions { display:flex; gap:6px; flex-wrap:wrap; }
  .empty { color:var(--dim); padding:18px; text-align:center; border:1px dashed var(--line); border-radius:10px; }
  .mini { font-size:13px; color:var(--dim); }
  .mini li { margin:3px 0; }
  #login { max-width:420px; margin:12vh auto; }
  #login input { width:100%; font:inherit; padding:9px; border-radius:7px; border:1px solid var(--line); background:#0f0c0a; color:var(--text); margin:10px 0; }
  .err { color:var(--red); }
  .toast { position:fixed; bottom:16px; left:50%; transform:translateX(-50%); background:#2c241d; border:1px solid var(--accent);
           padding:7px 14px; border-radius:8px; font-size:13px; display:none; }
</style>
</head>
<body>
<div id="login" hidden>
  <h1><b>Claude</b> Queue</h1>
  <p class="meta">Paste your view key (the <code>VIEW_KEY</code> secret). It is kept in this browser only.</p>
  <input id="key" type="password" autocomplete="off" placeholder="view key">
  <button id="save">Open</button> <span id="loginErr" class="err"></span>
</div>

<main id="app" hidden>
  <header>
    <h1><b>Claude</b> Queue</h1>
    <span class="meta" id="counts"></span>
    <span class="spacer"></span>
    <span class="meta" id="updated"></span>
    <button id="notifyBtn" title="Browser alert when a session starts waiting on a permission">Alerts: off</button>
    <button id="logout">Forget key</button>
  </header>

  <div id="waiting"></div>
  <h2 id="snoozedH" hidden>Snoozed</h2><div id="snoozed"></div>
  <h2>Working</h2><div id="working" class="mini"></div>
</main>
<div class="toast" id="toast"></div>

<script>
(() => {
  const $ = id => document.getElementById(id);
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };
  let key = store.get('cq.key') || '';
  let alerts = store.get('cq.alerts') === '1';
  let seenWaiting = null;   // ids waiting on a permission at the last refresh
  let timer = null;

  const LABEL = { permission: 'Needs permission', question: 'Asked you something', done: 'Finished' };

  function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function ago(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + 's';
    const m = Math.round(s / 60); if (m < 60) return m + 'm';
    const h = Math.floor(m / 60); if (h < 48) return h + 'h ' + (m % 60) + 'm';
    return Math.floor(h / 24) + 'd';
  }
  function toast(t) { const el = $('toast'); el.textContent = t; el.style.display = 'block'; clearTimeout(el._t); el._t = setTimeout(() => el.style.display = 'none', 1800); }
  function safeLink(u) { try { const x = new URL(u); return (x.protocol === 'https:' || x.protocol === 'claude:') ? x.href : ''; } catch { return ''; } }

  async function api(path, opts = {}) {
    const r = await fetch(path, { ...opts, headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' } });
    if (r.status === 401) { showLogin('That key was rejected.'); throw new Error('unauthorized'); }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }

  function card(s, now) {
    const waited = now - (s.waitingSince || s.updated);
    const old = waited > 30 * 60000;
    const link = safeLink(s.link);
    const where = [s.host, s.remote && s.host !== 'cloud' ? 'cloud' : '', s.cwd].filter(Boolean).join(' \xB7 ');
    return \`<div class="card \${esc(s.kind)}" data-id="\${esc(s.id)}">
      <div class="row1">
        <span class="proj">\${esc(s.project || '(no folder)')}</span>
        <span class="tag \${esc(s.kind)}">\${esc(LABEL[s.kind] || s.kind)}</span>
        <span class="age \${old ? 'old' : ''}">waiting \${ago(waited)}</span>
      </div>
      <div class="where">\${esc(where)}</div>
      \${s.summary ? \`<div class="summary">\${esc(s.summary)}</div>\` : ''}
      <div class="actions">
        \${link ? \`<a class="btn" href="\${esc(link)}" target="_blank" rel="noopener noreferrer">Open session</a>\` : ''}
        \${s.remote ? '' : \`<button data-act="copy">Copy resume command</button>\`}
        <button data-act="snooze" data-min="60">Snooze 1h</button>
        <button data-act="snooze" data-min="1440">Snooze 1d</button>
        <button data-act="dismiss">Dismiss</button>
      </div>
    </div>\`;
  }

  function setBadge(n, urgent) {
    document.title = (n ? \`(\${n}) \` : '') + 'Claude Queue';
    const c = document.createElement('canvas'); c.width = c.height = 32;
    const g = c.getContext('2d');
    g.fillStyle = n ? (urgent ? '#f87171' : '#f2a93b') : '#6fcf97';
    g.beginPath(); g.arc(16, 16, 15, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#16120f'; g.font = 'bold 18px system-ui,sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(n > 9 ? '9+' : String(n), 16, 17);
    $('fav').href = c.toDataURL();
  }

  let last = null;
  async function refresh() {
    try {
      const d = await api('/api/sessions');
      last = d;
      render(d);
      $('updated').textContent = 'updated ' + new Date().toLocaleTimeString();
    } catch (e) {
      if (e.message !== 'unauthorized') $('updated').innerHTML = '<span class="err">can\\'t reach the queue</span>';
    }
  }

  function render(d) {
    const now = Date.now();
    const perm = d.waiting.filter(s => s.kind === 'permission');
    $('counts').textContent = \`\${d.waiting.length} waiting \xB7 \${d.working.filter(s => now - s.updated < 12 * 3600000).length} working\` + (d.snoozed.length ? \` \xB7 \${d.snoozed.length} snoozed\` : '');
    $('waiting').innerHTML = d.waiting.length ? d.waiting.map(s => card(s, now)).join('')
      : '<div class="empty">Nothing is waiting on you.</div>';
    $('snoozedH').hidden = !d.snoozed.length;
    $('snoozed').innerHTML = d.snoozed.map(s => card(s, now)).join('');
    // Sessions closed without a SessionEnd linger as "working"; only list recent ones.
    const active = d.working.filter(s => now - s.updated < 12 * 3600000);
    $('working').innerHTML = active.length
      ? '<ul>' + active.map(s => \`<li><b>\${esc(s.project || '(no folder)')}</b> \xB7 \${esc(s.host)}\${s.remote && s.host !== 'cloud' ? ' \xB7 cloud' : ''} \xB7 active \${ago(now - s.updated)} ago</li>\`).join('') + '</ul>'
      : 'None.';
    setBadge(d.waiting.length, perm.length > 0);

    const ids = new Set(perm.map(s => s.id));
    if (alerts && seenWaiting && 'Notification' in window && Notification.permission === 'granted') {
      for (const s of perm) if (!seenWaiting.has(s.id))
        new Notification('Claude needs permission: ' + (s.project || 'a session'), { body: s.summary || '', tag: 'cq-' + s.id });
    }
    seenWaiting = ids;
  }

  document.addEventListener('click', async e => {
    const b = e.target.closest('button[data-act]'); if (!b) return;
    const cardEl = b.closest('.card'); const id = cardEl?.dataset.id; if (!id) return;
    const s = last && [...last.waiting, ...last.snoozed].find(x => x.id === id);
    const act = b.dataset.act;
    try {
      if (act === 'copy') {
        const cmd = (s && s.cwd ? \`cd "\${s.cwd}" && \` : '') + \`claude --resume \${id}\`;
        await navigator.clipboard.writeText(cmd); toast('Copied: ' + cmd); return;
      }
      if (act === 'snooze') await api(\`/api/sessions/\${encodeURIComponent(id)}/snooze\`, { method: 'POST', body: JSON.stringify({ minutes: +b.dataset.min }) });
      if (act === 'dismiss') await api(\`/api/sessions/\${encodeURIComponent(id)}/dismiss\`, { method: 'POST', body: '{}' });
      refresh();
    } catch (err) { if (err.message !== 'unauthorized') toast('That didn\\'t work: ' + err.message); }
  });

  function paintAlerts() { $('notifyBtn').textContent = 'Alerts: ' + (alerts ? 'on' : 'off'); }
  $('notifyBtn').onclick = async () => {
    if (!alerts && 'Notification' in window && Notification.permission !== 'granted') {
      const p = await Notification.requestPermission(); if (p !== 'granted') { toast('Browser alerts are blocked for this page'); return; }
    }
    alerts = !alerts; store.set('cq.alerts', alerts ? '1' : '0'); paintAlerts();
  };

  function showLogin(msg) {
    clearInterval(timer); $('app').hidden = true; $('login').hidden = false; $('loginErr').textContent = msg || ''; $('key').focus();
  }
  function showApp() {
    $('login').hidden = true; $('app').hidden = false; paintAlerts(); refresh();
    clearInterval(timer); timer = setInterval(refresh, 15000);
  }
  $('save').onclick = () => { key = $('key').value.trim(); if (!key) return; store.set('cq.key', key); showApp(); };
  $('key').addEventListener('keydown', e => { if (e.key === 'Enter') $('save').click(); });
  $('logout').onclick = () => { store.del('cq.key'); key = ''; showLogin(); };
  document.addEventListener('visibilitychange', () => { if (!document.hidden && key) refresh(); });
  setInterval(() => last && render(last), 30000);   // keep the "waiting 5m" ages moving between fetches

  key ? showApp() : showLogin();
})();
<\/script>
</body>
</html>
`;

// src/index.js
var MAX_SUMMARY = 400;
var PRUNE_AFTER_MS = 7 * 24 * 3600 * 1e3;
var RANK = { permission: 3, question: 2, done: 1, "": 0 };
var json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});
function sameKey(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !b) return false;
  const ea = new TextEncoder().encode(a), eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}
function authed(req, secret) {
  const h = req.headers.get("authorization") || "";
  return h.startsWith("Bearer ") && sameKey(h.slice(7).trim(), secret);
}
var clip = (s, n) => {
  s = typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "";
  return s.length > n ? s.slice(0, n - 1) + "\u2026" : s;
};
var tail = (s, n) => {
  s = typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "";
  if (s.length <= n) return s;
  const cut = s.slice(-(n - 1));
  const at = cut.search(/[.!?]\s+\S/);
  return "\u2026" + (at >= 0 && at < n / 3 ? cut.slice(at + 1).trimStart() : cut);
};
var str = (v, n = 300) => typeof v === "string" ? v.slice(0, n) : "";
function looksLikeQuestion(text) {
  const t = (text || "").trim();
  if (!t) return false;
  const tail2 = t.slice(-300);
  return /\?\s*(\*\*|`|\)|")?\s*$/.test(tail2) || /\?\s*\n/.test(tail2.slice(-120));
}
function nextState(ev, row) {
  const e = ev.event;
  if (e === "UserPromptSubmit" || e === "PostToolUse" || e === "SessionStart")
    return { state: "working", kind: "", summary: row?.summary || "" };
  if (e === "Stop") {
    const msg = ev.last_message || "";
    const asks = ev.asks === true || looksLikeQuestion(msg);
    return { state: "waiting", kind: asks ? "question" : "done", summary: tail(msg, MAX_SUMMARY) };
  }
  if (e === "Notification") {
    const t = ev.notification_type || "";
    if (t === "permission_prompt")
      return { state: "waiting", kind: "permission", summary: clip(ev.message || "Needs your permission", MAX_SUMMARY) };
    if (t === "elicitation_dialog" || t === "elicitation_url_dialog" || t === "agent_needs_input")
      return { state: "waiting", kind: "question", summary: clip(ev.message || "Needs your input", MAX_SUMMARY) };
    if (t === "idle_prompt") {
      if (row && row.state === "waiting") return { state: "waiting", kind: row.kind || "done", summary: row.summary };
      return { state: "waiting", kind: "done", summary: clip(ev.message || "Waiting for your input", MAX_SUMMARY) };
    }
    return null;
  }
  return null;
}
async function handleEvent(req, env) {
  let ev;
  try {
    ev = await req.json();
  } catch {
    return json({ error: "bad json" }, 400);
  }
  const id = str(ev.session_id, 100);
  if (!id) return json({ error: "session_id required" }, 400);
  const now = Date.now();
  if (ev.event === "SessionEnd") {
    await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(id).run();
    return json({ ok: true, state: "gone" });
  }
  const row = await env.DB.prepare("SELECT * FROM sessions WHERE id = ?").bind(id).first();
  const next = nextState(ev, row);
  if (!next) return json({ ok: true, ignored: true });
  if (row && row.state === "waiting" && next.state === "waiting" && ev.event === "Notification" && RANK[next.kind] < RANK[row.kind]) {
    next.kind = row.kind;
    next.summary = row.summary;
  }
  const waitingSince = next.state === "waiting" ? row && row.state === "waiting" ? row.waiting_since : now : null;
  const snoozed = next.state === "working" ? 0 : row?.snoozed_until || 0;
  await env.DB.prepare(
    `INSERT INTO sessions (id, project, cwd, host, remote, state, kind, summary, link, waiting_since, updated, snoozed_until)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
     ON CONFLICT(id) DO UPDATE SET
       project = CASE WHEN ?2 <> '' THEN ?2 ELSE project END,
       cwd     = CASE WHEN ?3 <> '' THEN ?3 ELSE cwd END,
       host    = CASE WHEN ?4 <> '' THEN ?4 ELSE host END,
       remote  = ?5, state = ?6, kind = ?7, summary = ?8,
       link    = CASE WHEN ?9 <> '' THEN ?9 ELSE link END,
       waiting_since = ?10, updated = ?11, snoozed_until = ?12`
  ).bind(
    id,
    str(ev.project, 120),
    str(ev.cwd, 400),
    str(ev.host, 80),
    ev.remote ? 1 : 0,
    next.state,
    next.kind,
    next.summary,
    str(ev.link, 400),
    waitingSince,
    now,
    snoozed
  ).run();
  return json({ ok: true, state: next.state, kind: next.kind });
}
async function listSessions(env) {
  const { results } = await env.DB.prepare("SELECT * FROM sessions ORDER BY updated DESC LIMIT 500").all();
  const now = Date.now();
  const out = { now, waiting: [], snoozed: [], working: [] };
  for (const r of results) {
    const s = {
      id: r.id,
      project: r.project,
      cwd: r.cwd,
      host: r.host,
      remote: !!r.remote,
      state: r.state,
      kind: r.kind,
      summary: r.summary,
      link: r.link,
      waitingSince: r.waiting_since,
      updated: r.updated,
      snoozedUntil: r.snoozed_until
    };
    if (r.state !== "waiting") out.working.push(s);
    else if (r.snoozed_until > now) out.snoozed.push(s);
    else out.waiting.push(s);
  }
  out.waiting.sort((a, b) => RANK[b.kind] - RANK[a.kind] || a.waitingSince - b.waitingSince);
  return json(out);
}
async function sessionAction(req, env, id, action) {
  if (action === "delete") {
    await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(id).run();
    return json({ ok: true });
  }
  if (action === "dismiss") {
    await env.DB.prepare("UPDATE sessions SET state = 'working', kind = '', waiting_since = NULL, snoozed_until = 0 WHERE id = ?").bind(id).run();
    return json({ ok: true });
  }
  if (action === "snooze") {
    let minutes = 60;
    try {
      const b = await req.json();
      if (Number.isFinite(b.minutes)) minutes = b.minutes;
    } catch {
    }
    minutes = Math.min(Math.max(minutes, 1), 7 * 24 * 60);
    await env.DB.prepare("UPDATE sessions SET snoozed_until = ? WHERE id = ?").bind(Date.now() + minutes * 6e4, id).run();
    return json({ ok: true });
  }
  return json({ error: "unknown action" }, 404);
}
var index_default = {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;
    if (req.method === "GET" && (p === "/" || p === "/index.html"))
      return new Response(page_default, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff"
        }
      });
    if (p === "/health") return json({ ok: true });
    if (p === "/api/event" && req.method === "POST") {
      if (!authed(req, env.INGEST_KEY)) return json({ error: "unauthorized" }, 401);
      return handleEvent(req, env);
    }
    if (p.startsWith("/api/sessions")) {
      if (!authed(req, env.VIEW_KEY)) return json({ error: "unauthorized" }, 401);
      if (p === "/api/sessions" && req.method === "GET") return listSessions(env);
      const m = p.match(/^\/api\/sessions\/([^/]+)(?:\/(snooze|dismiss))?$/);
      if (m) {
        const id = decodeURIComponent(m[1]).slice(0, 100);
        if (req.method === "DELETE" && !m[2]) return sessionAction(req, env, id, "delete");
        if (req.method === "POST" && m[2]) return sessionAction(req, env, id, m[2]);
      }
    }
    return json({ error: "not found" }, 404);
  },
  async scheduled(_ev, env) {
    await env.DB.prepare("DELETE FROM sessions WHERE updated < ?").bind(Date.now() - PRUNE_AFTER_MS).run();
  }
};
export {
  index_default as default,
  nextState
};
