// Claude Queue — Cloudflare Worker.
// Takes state reports from the Claude Code plugin hooks and serves one list of
// every session that is waiting on you.
//
//   POST /api/event                 Bearer INGEST_KEY   (the hooks)
//   GET  /api/sessions              Bearer VIEW_KEY     (the page)
//   POST /api/sessions/:id/snooze   Bearer VIEW_KEY     {"minutes": 60}
//   POST /api/sessions/:id/dismiss  Bearer VIEW_KEY     (back to "working", off the list)
//   DELETE /api/sessions/:id        Bearer VIEW_KEY
//   GET  /                          the web page (asks for the view key, keeps it in this browser)
//   GET  /health                    no auth, no details

import PAGE from './page.html';

const MAX_SUMMARY = 400;
const PRUNE_AFTER_MS = 7 * 24 * 3600 * 1000;
const RANK = { permission: 3, question: 2, done: 1, '': 0 };

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

// Constant-time compare so a key can't be guessed byte by byte.
function sameKey(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !b) return false;
  const ea = new TextEncoder().encode(a), eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}
function authed(req, secret) {
  const h = req.headers.get('authorization') || '';
  return h.startsWith('Bearer ') && sameKey(h.slice(7).trim(), secret);
}

const clip = (s, n) => {
  s = typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};
// Keep the end of a long reply: that's where Claude asks its question.
const tail = (s, n) => {
  s = typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '';
  if (s.length <= n) return s;
  const cut = s.slice(-(n - 1));
  const at = cut.search(/[.!?]\s+\S/);   // start at a sentence if one begins early enough
  return '…' + (at >= 0 && at < n / 3 ? cut.slice(at + 1).trimStart() : cut);
};
const str = (v, n = 300) => (typeof v === 'string' ? v.slice(0, n) : '');

// Is the end of Claude's reply asking you something?
function looksLikeQuestion(text) {
  const t = (text || '').trim();
  if (!t) return false;
  const tail = t.slice(-300);
  return /\?\s*(\*\*|`|\)|")?\s*$/.test(tail) || /\?\s*\n/.test(tail.slice(-120));
}

// Turn one hook report into the row's new state.
// Returns null to ignore the event.
export function nextState(ev, row) {
  const e = ev.event;
  if (e === 'UserPromptSubmit' || e === 'PostToolUse' || e === 'SessionStart')
    return { state: 'working', kind: '', summary: row?.summary || '' };
  if (e === 'Stop') {
    const msg = ev.last_message || '';
    const asks = ev.asks === true || looksLikeQuestion(msg);
    return { state: 'waiting', kind: asks ? 'question' : 'done', summary: tail(msg, MAX_SUMMARY) };
  }
  if (e === 'Notification') {
    const t = ev.notification_type || '';
    if (t === 'permission_prompt')
      return { state: 'waiting', kind: 'permission', summary: clip(ev.message || 'Needs your permission', MAX_SUMMARY) };
    if (t === 'elicitation_dialog' || t === 'elicitation_url_dialog' || t === 'agent_needs_input')
      return { state: 'waiting', kind: 'question', summary: clip(ev.message || 'Needs your input', MAX_SUMMARY) };
    if (t === 'idle_prompt') {
      // "Still waiting for you" after a Stop: keep what Stop said, just make sure it shows.
      if (row && row.state === 'waiting') return { state: 'waiting', kind: row.kind || 'done', summary: row.summary };
      return { state: 'waiting', kind: 'done', summary: clip(ev.message || 'Waiting for your input', MAX_SUMMARY) };
    }
    return null;
  }
  return null;
}

async function handleEvent(req, env) {
  let ev;
  try { ev = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
  const id = str(ev.session_id, 100);
  if (!id) return json({ error: 'session_id required' }, 400);
  const now = Date.now();

  if (ev.event === 'SessionEnd') {
    await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(id).run();
    return json({ ok: true, state: 'gone' });
  }

  const row = await env.DB.prepare('SELECT * FROM sessions WHERE id = ?').bind(id).first();
  const next = nextState(ev, row);
  if (!next) return json({ ok: true, ignored: true });

  // A permission prompt outranks a later "idle" ping; don't let a weaker kind
  // overwrite a stronger one while the session is still waiting.
  if (row && row.state === 'waiting' && next.state === 'waiting' && ev.event === 'Notification'
      && RANK[next.kind] < RANK[row.kind]) {
    next.kind = row.kind; next.summary = row.summary;
  }

  const waitingSince = next.state === 'waiting'
    ? (row && row.state === 'waiting' ? row.waiting_since : now)
    : null;
  const snoozed = next.state === 'working' ? 0 : (row?.snoozed_until || 0);

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
  ).bind(id, str(ev.project, 120), str(ev.cwd, 400), str(ev.host, 80), ev.remote ? 1 : 0,
         next.state, next.kind, next.summary, str(ev.link, 400), waitingSince, now, snoozed).run();

  return json({ ok: true, state: next.state, kind: next.kind });
}

async function listSessions(env) {
  const { results } = await env.DB.prepare('SELECT * FROM sessions ORDER BY updated DESC LIMIT 500').all();
  const now = Date.now();
  const out = { now, waiting: [], snoozed: [], working: [] };
  for (const r of results) {
    const s = {
      id: r.id, project: r.project, cwd: r.cwd, host: r.host, remote: !!r.remote,
      state: r.state, kind: r.kind, summary: r.summary, link: r.link,
      waitingSince: r.waiting_since, updated: r.updated, snoozedUntil: r.snoozed_until,
    };
    if (r.state !== 'waiting') out.working.push(s);
    else if (r.snoozed_until > now) out.snoozed.push(s);
    else out.waiting.push(s);
  }
  out.waiting.sort((a, b) => (RANK[b.kind] - RANK[a.kind]) || (a.waitingSince - b.waitingSince));
  return json(out);
}

async function sessionAction(req, env, id, action) {
  if (action === 'delete') {
    await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(id).run();
    return json({ ok: true });
  }
  if (action === 'dismiss') {
    await env.DB.prepare("UPDATE sessions SET state = 'working', kind = '', waiting_since = NULL, snoozed_until = 0 WHERE id = ?")
      .bind(id).run();
    return json({ ok: true });
  }
  if (action === 'snooze') {
    let minutes = 60;
    try { const b = await req.json(); if (Number.isFinite(b.minutes)) minutes = b.minutes; } catch {}
    minutes = Math.min(Math.max(minutes, 1), 7 * 24 * 60);
    await env.DB.prepare('UPDATE sessions SET snoozed_until = ? WHERE id = ?').bind(Date.now() + minutes * 60000, id).run();
    return json({ ok: true });
  }
  return json({ error: 'unknown action' }, 404);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;

    if (req.method === 'GET' && (p === '/' || p === '/index.html'))
      return new Response(PAGE, {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
          'referrer-policy': 'no-referrer',
          'x-content-type-options': 'nosniff',
        },
      });
    if (p === '/health') return json({ ok: true });

    if (p === '/api/event' && req.method === 'POST') {
      if (!authed(req, env.INGEST_KEY)) return json({ error: 'unauthorized' }, 401);
      return handleEvent(req, env);
    }

    if (p.startsWith('/api/sessions')) {
      if (!authed(req, env.VIEW_KEY)) return json({ error: 'unauthorized' }, 401);
      if (p === '/api/sessions' && req.method === 'GET') return listSessions(env);
      const m = p.match(/^\/api\/sessions\/([^/]+)(?:\/(snooze|dismiss))?$/);
      if (m) {
        const id = decodeURIComponent(m[1]).slice(0, 100);
        if (req.method === 'DELETE' && !m[2]) return sessionAction(req, env, id, 'delete');
        if (req.method === 'POST' && m[2]) return sessionAction(req, env, id, m[2]);
      }
    }
    return json({ error: 'not found' }, 404);
  },

  async scheduled(_ev, env) {
    await env.DB.prepare('DELETE FROM sessions WHERE updated < ?').bind(Date.now() - PRUNE_AFTER_MS).run();
  },
};
