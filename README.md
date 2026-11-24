# Claude Queue

One list of every Claude Code session that is waiting on you.

If you keep a lot of sessions open across projects, machines and the cloud, the little dots in the app
stop being enough. Claude Queue is a Claude Code plugin plus a small Cloudflare Worker you host. Each
session's hooks report what it's doing, and one web page shows everything that needs you, sorted:

- **Needs permission** (red): a tool call is blocked until you answer.
- **Asked you something** (amber): Claude finished a turn with a question.
- **Finished** (green): Claude is done and it's your turn.

Each card shows the project folder, the machine, how long it has waited (red after 30 minutes) and the
end of Claude's last reply, so you know what it wants before you switch to it. You can snooze a card for
an hour or a day, or dismiss it. The page's tab title and icon carry the count, and it can raise a
browser alert when a session gets stuck on a permission. Sessions that are still working are listed
underneath.

Unofficial. Not made or endorsed by Anthropic.

## How it works

```
Claude Code session ──hooks──▶ hook.js ──HTTPS──▶ your Worker (D1) ◀── web page
```

The plugin hooks `UserPromptSubmit`, `Stop`, `Notification` (permission prompts, idle prompts,
questions), `PostToolUse` and `SessionEnd`. `hook.js` turns each into a small report: session id, event,
folder, machine name, and (unless you turn it off) the notification text or the end of Claude's last
reply. It never blocks Claude: it prints nothing, always exits 0, and gives up after 3 seconds.
`PostToolUse` only sends anything right after a permission prompt, to clear it once you've answered.

## Set up the Worker

You need a Cloudflare account (the free plan is plenty) and Node 20+.

```
cd worker
npm install
npx wrangler login
npx wrangler d1 create claude-queue        # paste the database_id it prints into wrangler.toml
npm run db:init
npx wrangler secret put INGEST_KEY         # the hooks send this
npx wrangler secret put VIEW_KEY           # you type this into the page
npm run deploy
```

Use long random values for both keys (for example `openssl rand -hex 24`), and keep them different: the
ingest key ends up on every machine you run Claude on, while the view key only goes in your browser.

Open the Worker's URL, paste the view key, and bookmark it. The key is kept in that browser only.

## Install the plugin

In Claude Code:

```
/plugin marketplace add VAROIndustries/claude-queue
/plugin install claude-queue@claude-queue
```

Then tell it where your Worker is. On your own machines, create `~/.claude-queue.json`:

```json
{ "url": "https://claude-queue.<your-subdomain>.workers.dev", "key": "<INGEST_KEY>" }
```

or set environment variables instead (they win over the file):

| Variable | |
|----------|---|
| `CLAUDE_QUEUE_URL` | your Worker's URL |
| `CLAUDE_QUEUE_KEY` | the Worker's `INGEST_KEY` |
| `CLAUDE_QUEUE_HOST` | optional name for this machine (default: its hostname, or `cloud`) |
| `CLAUDE_QUEUE_SEND_TEXT` | `0` to send state only, never message text |
| `CLAUDE_QUEUE_LINK` | optional link template with `{session_id}`, shown as an *Open session* button |
| `CLAUDE_QUEUE_DEBUG` | `1` to log each report to `claude-queue-hook.log` in the temp folder |

**Cloud sessions** don't read your local `~/.claude/settings.json` or your home folder, so the file above
won't reach them, but plugin hooks do run there. Give them `CLAUDE_QUEUE_URL` and `CLAUDE_QUEUE_KEY` as
environment variables in the cloud environment's settings, if your environment offers them; otherwise
cloud sessions report nothing.

`hook.js` needs Node 18 or newer on `PATH`.

## What it can't do (yet)

- **Jump straight to a session.** The `session_id` a hook receives isn't the ID in a claude.ai session
  URL, so the page can't link there by itself. For local sessions it gives you a
  `claude --resume <id>` command to copy; `CLAUDE_QUEUE_LINK` adds a button if you have a URL pattern
  that works for you.
- **Anything that doesn't run hooks.** Only sessions running on Claude Code (terminal, IDE, desktop app,
  cloud) fire hooks. A conversation that doesn't run on Claude Code never shows up.
- **Know a session closed if it didn't say so.** A session that ends without `SessionEnd` (a killed
  terminal, a machine that slept) stays on the list until you dismiss it; the Worker deletes anything
  not heard from in 7 days, and the page stops listing idle "working" sessions after 12 hours.

## Privacy

Everything goes to your own Worker and D1 database, nowhere else. With text on, the Worker stores the
notification message and up to the last 400 characters of Claude's final reply per session. Turn that off
with `CLAUDE_QUEUE_SEND_TEXT=0`: you still get the state and the "asked you something" flag, with no text.

## API

| | Auth | |
|-|------|-|
| `POST /api/event` | `Bearer INGEST_KEY` | a hook report |
| `GET /api/sessions` | `Bearer VIEW_KEY` | `{ waiting, snoozed, working }`, most urgent first |
| `POST /api/sessions/:id/snooze` | `Bearer VIEW_KEY` | `{ "minutes": 60 }` |
| `POST /api/sessions/:id/dismiss` | `Bearer VIEW_KEY` | off the list until it next waits |
| `DELETE /api/sessions/:id` | `Bearer VIEW_KEY` | forget it |
| `GET /health` | none | `{ "ok": true }` |

`GET /api/sessions` is enough to build your own display: a tray icon, a phone widget, a desk dial.

## License

MIT. Made by [VARO Industries](https://varo.industries).
