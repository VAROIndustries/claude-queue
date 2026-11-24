#!/usr/bin/env node
// Claude Queue hook: tells your Claude Queue Worker what this session is doing.
// Runs on UserPromptSubmit, Stop, Notification, PostToolUse and SessionEnd.
//
// It never blocks or changes Claude: it prints nothing, always exits 0, and gives
// up on the network after 3 seconds.
//
// Configuration (environment variables win over the file):
//   CLAUDE_QUEUE_URL        https://claude-queue.<you>.workers.dev
//   CLAUDE_QUEUE_KEY        the Worker's INGEST_KEY
//   CLAUDE_QUEUE_HOST       optional label for this machine (default: its hostname, or "cloud")
//   CLAUDE_QUEUE_SEND_TEXT  "0" to send no message text, only state (default "1")
//   CLAUDE_QUEUE_LINK       optional link template, e.g. https://example/{session_id}
// Files, first found wins: ~/.claude-queue.json, then config.json next to this script
//   {"url": "...", "key": "...", "host": "...", "sendText": true,
//    "projects": {"<claude.ai project uuid>": "Name to show"}}
// The second one lets a private copy of the plugin carry its own settings into cloud
// sessions, which can't see your home folder.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const LOG = process.env.CLAUDE_QUEUE_DEBUG ? path.join(os.tmpdir(), 'claude-queue-hook.log') : null;
const log = (...a) => { if (LOG) try { fs.appendFileSync(LOG, new Date().toISOString() + ' ' + a.join(' ') + '\n'); } catch {} };

function config() {
  let file = {};
  for (const f of [path.join(os.homedir(), '.claude-queue.json'), path.join(__dirname, 'config.json')]) {
    try { file = JSON.parse(fs.readFileSync(f, 'utf8')); break; } catch {}
  }
  const env = process.env;
  const sendText = env.CLAUDE_QUEUE_SEND_TEXT != null ? env.CLAUDE_QUEUE_SEND_TEXT !== '0' : file.sendText !== false;
  return {
    url: (env.CLAUDE_QUEUE_URL || file.url || '').replace(/\/+$/, ''),
    key: env.CLAUDE_QUEUE_KEY || file.key || '',
    host: env.CLAUDE_QUEUE_HOST || file.host || '',
    link: env.CLAUDE_QUEUE_LINK || file.link || '',
    projects: (file.projects && typeof file.projects === 'object') ? file.projects : {},
    sendText,
  };
}

function readStdin() {
  return new Promise(resolve => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', c => { data += c; if (data.length > 2_000_000) process.stdin.destroy(); });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
    setTimeout(() => resolve(data), 2000);
  });
}

// Remember per session whether we last reported "waiting", so PostToolUse (which fires
// after every tool call) only costs a request right after a permission was answered.
const stateDir = path.join(os.tmpdir(), 'claude-queue');
const stateFile = id => path.join(stateDir, id.replace(/[^A-Za-z0-9_-]/g, '_') + '.state');
const getLocal = id => { try { return fs.readFileSync(stateFile(id), 'utf8'); } catch { return ''; } };
const setLocal = (id, s) => { try { fs.mkdirSync(stateDir, { recursive: true }); fs.writeFileSync(stateFile(id), s); } catch {} };
const dropLocal = id => { try { fs.unlinkSync(stateFile(id)); } catch {} };

// Which state the Worker will end up in for this event (mirrors worker nextState()).
function localState(event, notificationType) {
  if (event === 'Stop') return 'waiting';
  if (event === 'Notification')
    return ['permission_prompt', 'idle_prompt', 'elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input']
      .includes(notificationType) ? 'waiting' : null;
  if (event === 'UserPromptSubmit' || event === 'PostToolUse' || event === 'SessionStart') return 'working';
  return null;
}

async function main() {
  const cfg = config();
  const raw = await readStdin();
  let input;
  try { input = JSON.parse(raw); } catch { return; }
  const id = input.session_id;
  const event = input.hook_event_name;
  if (!id || !event) return;

  const ntype = input.notification_type || '';
  if (event === 'SessionEnd') dropLocal(id);
  else {
    const next = localState(event, ntype);
    if (!next) return;
    // PostToolUse: only worth a request if the Worker still thinks we're waiting.
    if (event === 'PostToolUse' && getLocal(id) !== 'waiting') return;
    setLocal(id, next);
  }
  if (!cfg.url || !cfg.key) { log('not configured'); return; }

  const env = process.env;
  const remote = env.CLAUDE_CODE_REMOTE === 'true';
  const cwd = typeof input.cwd === 'string' ? input.cwd : '';
  // A conversation in the Claude app runs in a scratch folder, so its folder name says
  // nothing; name it after its claude.ai Project instead when there is one.
  const fromApp = env.CLAUDE_CODE_SESSION_ORIGIN === 'claude_ai_chat';
  const projectUuid = env.CLAUDE_PROJECT_UUID || '';
  let project = cwd.split(/[\\/]+/).filter(Boolean).pop() || '';   // last folder, Windows paths too
  if (fromApp) project = cfg.projects[projectUuid] || (projectUuid ? 'Project ' + projectUuid.slice(0, 8) : 'Chat');
  const body = {
    session_id: id,
    event,
    notification_type: ntype,
    cwd: fromApp ? '' : cwd,
    project,
    host: cfg.host || (fromApp ? 'Claude app' : remote ? 'cloud' : os.hostname()),
    remote,
    link: cfg.link ? cfg.link.replace('{session_id}', encodeURIComponent(id)) : '',
  };
  if (cfg.sendText) {
    if (typeof input.message === 'string') body.message = input.message.slice(0, 2000);
    if (typeof input.last_assistant_message === 'string') body.last_message = input.last_assistant_message.slice(-4000);
  } else if (event === 'Stop' && typeof input.last_assistant_message === 'string') {
    // No text leaves the machine, but keep the "asked you something" flag working.
    body.asks = /\?\s*\W*\s*$/.test(input.last_assistant_message.trim().slice(-300));
  }

  try {
    const res = await fetch(cfg.url + '/api/event', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + cfg.key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    });
    log(event, ntype, res.status);
  } catch (e) {
    log(event, ntype, 'error', e && e.message);
  }
}

main().catch(e => log('fatal', e && e.message)).finally(() => process.exit(0));
