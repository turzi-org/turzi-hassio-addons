/**
 * The operator's view of the log.
 *
 * Served on the ingress port only, never on the public listener. Home
 * Assistant authenticates ingress itself, so there is no API key here — and
 * that is exactly why this router must not be mounted alongside the integrator
 * API, where it would be an unauthenticated window onto the same data.
 *
 * Read-only by construction: it issues SELECTs and offers no route that
 * writes. The record of who opened a door is not something a viewer edits.
 */

import { Pool, RowDataPacket } from 'mysql2/promise';
import { Router } from 'express';
import { Config } from '../config';
import { HaClient } from '../ha/ha-client';
import { asyncHandler, HttpError } from '../middleware/errors';

const MAX_ROWS = 500;

interface Summary extends RowDataPacket {
    total: number;
    confirmed: number;
    failed: number;
    actors: string | null;
    last_at: Date | null;
}

/**
 * A range bound. The page sends UTC instants — it converts what the operator
 * typed from the building's timezone before asking, so the server never has to
 * reason about zones and the SQL stays a plain comparison.
 */
function instant(value: unknown, name: string): Date | undefined {
    if (value === undefined || value === '') return undefined;
    const d = new Date(String(value));
    if (Number.isNaN(d.getTime())) throw new HttpError(400, 'INVALID_RANGE', `${name} is not a timestamp`);
    return d;
}

export function uiRouter(pool: Pool, config: Config, client: HaClient): Router {
    const router = Router();

    router.get('/data', asyncHandler(async (req, res) => {
        const raw = Number(req.query.limit ?? 100);
        const limit = Number.isInteger(raw) && raw > 0 && raw <= MAX_ROWS ? raw : 100;
        const from = instant(req.query.from, 'from');
        const to = instant(req.query.to, 'to');

        // Built once and reused for all three queries, against the column each
        // table actually orders by.
        const range = (column: string) => {
            const clauses: string[] = [];
            const params: Date[] = [];
            if (from) { clauses.push(`${column} >= ?`); params.push(from); }
            if (to) { clauses.push(`${column} <= ?`); params.push(to); }
            return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
        };
        const cmdRange = range('issued_at');
        const stateRange = range('observed_at');

        // LIMIT is interpolated, not bound: validated as an integer above, and
        // MariaDB rejects a placeholder there on a prepared statement.
        const [commands] = await pool.execute<RowDataPacket[]>(
            `SELECT command_id, entity_id, command, actor_label, status, reason,
                    resulting_state, publish_ms, state_echo_ms, issued_at
               FROM command_log ${cmdRange.where} ORDER BY issued_at DESC LIMIT ${limit}`,
            cmdRange.params,
        );
        const [states] = await pool.execute<RowDataPacket[]>(
            `SELECT entity_id, state, attributes, origin_type, origin_command_id, observed_at
               FROM state_log ${stateRange.where} ORDER BY observed_at DESC, id DESC LIMIT ${limit}`,
            stateRange.params,
        );
        // Summarises the selected range, not all of history — otherwise the
        // cards would contradict the table beneath them.
        const [[summary]] = await pool.execute<Summary[]>(
            `SELECT COUNT(*) AS total,
                    SUM(status IN ('confirmed','executed')) AS confirmed,
                    SUM(status = 'failed') AS failed,
                    GROUP_CONCAT(DISTINCT actor_label ORDER BY actor_label) AS actors,
                    MAX(issued_at) AS last_at
               FROM command_log ${cmdRange.where}`,
            cmdRange.params,
        );

        res.json({
            house_id: config.houseId,
            // Falls back to UTC, and the page says which it is showing.
            time_zone: client.timeZone() ?? 'UTC',
            truncated: commands.length >= limit || states.length >= limit,
            summary,
            commands,
            // MariaDB hands JSON columns back as text; parse so the page does not have to.
            states: states.map((r) => {
                const a = (r as Record<string, unknown>).attributes;
                if (typeof a === 'string') {
                    try { (r as Record<string, unknown>).attributes = JSON.parse(a); } catch { /* keep as text */ }
                }
                return r;
            }),
        });
    }));

    router.get('/', (_req, res) => {
        res.type('html').send(PAGE);
    });

    return router;
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Gate log</title>
<style>
  :root {
    --bg: #f6f7f9; --card: #ffffff; --ink: #16181d; --muted: #6b7280;
    --line: #e3e6ea; --line-soft: #eef0f3;
    --ok: #1f7a4c; --ok-bg: #e8f3ed; --warn: #96650b; --warn-bg: #fbf1dc;
    --err: #b3261e; --err-bg: #fbeae8; --accent: #b06a00;
    --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #111418; --card: #181c22; --ink: #e7eaee; --muted: #98a1ad;
      --line: #272d35; --line-soft: #1f242b;
      --ok: #56c98d; --ok-bg: #16261d; --warn: #e0ac4d; --warn-bg: #241c0c;
      --err: #f2837a; --err-bg: #2a1614; --accent: #f2b23c;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  .wrap { max-width: 1180px; margin: 0 auto; padding: 20px 18px 64px; }
  header { display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; margin-bottom: 18px; }
  h1 { font-size: 20px; margin: 0; letter-spacing: -.01em; }
  .site { font-family: var(--mono); font-size: 12px; color: var(--muted); }
  .spacer { flex: 1 1 auto; }
  .controls { display: flex; align-items: center; gap: 10px; font-size: 13px; color: var(--muted); }
  select, button {
    font: inherit; color: var(--ink); background: var(--card);
    border: 1px solid var(--line); border-radius: 6px; padding: 5px 9px; cursor: pointer;
  }
  button:hover, select:hover { border-color: var(--muted); }
  button:focus-visible, select:focus-visible, a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  input[type="datetime-local"] {
    font: inherit; color: var(--ink); background: var(--card);
    border: 1px solid var(--line); border-radius: 6px; padding: 4px 8px;
  }
  input[type="datetime-local"]:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .custom { display: inline-flex; align-items: center; gap: 6px; }
  .custom[hidden] { display: none; }
  .dash { color: var(--muted); }
  .tzline { margin: -8px 0 16px; font-size: 12.5px; color: var(--muted); }
  .tzline b { font-weight: 600; color: var(--ink); font-family: var(--mono); }

  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 22px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 13px 15px; }
  .card .k { font-size: 11px; letter-spacing: .09em; text-transform: uppercase; color: var(--muted); }
  .card .v { font-size: 22px; font-weight: 600; margin-top: 3px; font-variant-numeric: tabular-nums; }
  .card .v.small { font-size: 14px; font-weight: 500; font-family: var(--mono); word-break: break-all; }

  h2 { font-size: 14px; text-transform: uppercase; letter-spacing: .09em; color: var(--muted); margin: 26px 0 10px; font-weight: 600; }
  .panel { background: var(--card); border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
  .scroll { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 13.2px; min-width: 660px; }
  th, td { text-align: left; padding: 9px 14px; border-bottom: 1px solid var(--line-soft); white-space: nowrap; }
  th { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); background: var(--bg); position: sticky; top: 0; }
  tr:last-child td { border-bottom: 0; }
  td.mono, .mono { font-family: var(--mono); font-size: 12.4px; }
  td.num { font-family: var(--mono); font-variant-numeric: tabular-nums; text-align: right; }
  td.reason { white-space: normal; color: var(--err); max-width: 320px; }

  .pill { display: inline-block; font-size: 11.5px; font-weight: 600; padding: 2px 8px; border-radius: 999px; font-family: var(--mono); }
  .p-ok { color: var(--ok); background: var(--ok-bg); }
  .p-warn { color: var(--warn); background: var(--warn-bg); }
  .p-err { color: var(--err); background: var(--err-bg); }
  .p-mute { color: var(--muted); background: var(--line-soft); }

  .empty { padding: 26px 16px; color: var(--muted); text-align: center; }
  .err-banner { background: var(--err-bg); color: var(--err); border: 1px solid var(--err); border-radius: 8px; padding: 12px 14px; margin-bottom: 16px; }
  .muted { color: var(--muted); }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Gate log</h1>
    <span class="site" id="site"></span>
    <span class="spacer"></span>
    <div class="controls">
      <label>Range
        <select id="preset">
          <option value="today">Today</option>
          <option value="24h" selected>Last 24 hours</option>
          <option value="7d">Last 7 days</option>
          <option value="30d">Last 30 days</option>
          <option value="all">All</option>
          <option value="custom">Custom&hellip;</option>
        </select>
      </label>
      <span id="custom" class="custom" hidden>
        <input type="datetime-local" id="from" step="1" aria-label="From">
        <span class="dash">&rarr;</span>
        <input type="datetime-local" id="to" step="1" aria-label="To">
      </span>
      <label>Rows
        <select id="limit">
          <option>50</option><option selected>100</option><option>250</option><option>500</option>
        </select>
      </label>
      <label><input type="checkbox" id="auto"> auto</label>
      <button id="refresh" type="button">Refresh</button>
    </div>
  </header>
  <p class="tzline" id="tzline"></p>

  <div id="banner"></div>
  <div class="cards" id="cards"></div>

  <h2>Commands issued through this API</h2>
  <div class="panel"><div class="scroll"><table>
    <thead><tr><th>When</th><th>Actor</th><th>Command</th><th>Status</th><th>Result</th><th>Echo</th><th>Reason</th></tr></thead>
    <tbody id="cmds"></tbody>
  </table></div></div>

  <h2>State changes &mdash; including those this API did not cause</h2>
  <div class="panel"><div class="scroll"><table>
    <thead><tr><th>When</th><th>Entity</th><th>State</th><th>Position</th><th>Caused by</th></tr></thead>
    <tbody id="states"></tbody>
  </table></div></div>

  <p class="muted" style="margin-top:18px; font-size:12.5px;">
    <strong>unattributed</strong> means the change carried no Home Assistant context &mdash;
    the gate's own movement ticks land here, and so does anything done from the Turzi app.
  </p>
</div>

<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

// Times are stored in UTC and shown in the BUILDING's timezone, which Home
// Assistant reports. A gate opening is an event at the gate; describing it in
// the viewer's timezone would be wrong the moment anyone reads it from
// elsewhere.
let TZ = 'UTC';

/** Offset of 'tz' from UTC at 'date', in ms. Positive east of Greenwich. */
function tzOffsetMs(date, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date);
  const p = {};
  for (const part of parts) p[part.type] = part.value;
  const hour = p.hour === '24' ? 0 : Number(p.hour);
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day),
                  hour, Number(p.minute), Number(p.second)) - date.getTime();
}

/** A UTC instant, rendered as the wall clock in TZ. */
function fmt(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (isNaN(d)) return '—';
  return new Date(d.getTime() + tzOffsetMs(d, TZ)).toISOString().slice(0, 19).replace('T', ' ');
}

/** A wall clock typed in TZ ("2026-08-28T14:30"), as a UTC instant. */
function wallToUtc(text) {
  if (!text) return '';
  const guess = new Date(text.length === 16 ? text + ':00Z' : text + 'Z');
  if (isNaN(guess)) return '';
  let utc = new Date(guess.getTime() - tzOffsetMs(guess, TZ));
  // One correction: near a DST change the first offset can be the wrong side.
  const settled = tzOffsetMs(utc, TZ);
  if (settled !== tzOffsetMs(guess, TZ)) utc = new Date(guess.getTime() - settled);
  return utc.toISOString();
}

/** Now, as a Date whose UTC fields read as the TZ wall clock. */
function wallNow() {
  const now = new Date();
  return new Date(now.getTime() + tzOffsetMs(now, TZ));
}

function rangeFor(preset) {
  const nowMs = Date.now();
  const hours = (h) => new Date(nowMs - h * 3600e3).toISOString();
  switch (preset) {
    case 'today': return { from: wallToUtc(wallNow().toISOString().slice(0, 10) + 'T00:00:00'), to: '' };
    case '24h':   return { from: hours(24), to: '' };
    case '7d':    return { from: hours(24 * 7), to: '' };
    case '30d':   return { from: hours(24 * 30), to: '' };
    case 'custom':return { from: wallToUtc($('from').value), to: wallToUtc($('to').value) };
    default:      return { from: '', to: '' };
  }
}

function statusPill(s) {
  const cls = s === 'confirmed' ? 'p-ok' : s === 'executed' ? 'p-warn' : s === 'failed' ? 'p-err' : 'p-mute';
  return '<span class="pill ' + cls + '">' + esc(s) + '</span>';
}
function originPill(o) {
  const cls = o === 'external_api' ? 'p-ok' : (o === 'core_user' || o === 'automation') ? 'p-warn' : 'p-mute';
  return '<span class="pill ' + cls + '">' + esc(o) + '</span>';
}

async function load() {
  $('banner').innerHTML = '';
  const preset = $('preset').value;
  const { from, to } = rangeFor(preset);
  const qs = new URLSearchParams({ limit: $('limit').value });
  if (from) qs.set('from', from);
  if (to) qs.set('to', to);

  try {
    const res = await fetch('./data?' + qs.toString(), { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const d = await res.json();

    if (d.time_zone && d.time_zone !== TZ) {
      TZ = d.time_zone;
      seedCustom();
    }
    $('site').textContent = d.house_id;
    $('tzline').innerHTML = 'Times shown in <b>' + esc(TZ) + '</b>' +
      (d.truncated ? ' &middot; showing the most recent ' + esc($('limit').value) +
                     ' rows only &mdash; narrow the range or raise the row count to see the rest' : '');

    const s = d.summary || {};
    $('cards').innerHTML = [
      ['Commands', s.total ?? 0, ''],
      ['Succeeded', s.confirmed ?? 0, ''],
      ['Failed', s.failed ?? 0, ''],
      ['Callers', s.actors || '—', 'small'],
      ['Last command', fmt(s.last_at), 'small'],
    ].map(([k, v, cls]) =>
      '<div class="card"><div class="k">' + k + '</div><div class="v ' + (cls || '') + '">' + esc(v) + '</div></div>'
    ).join('');

    $('cmds').innerHTML = d.commands.length ? d.commands.map((r) =>
      '<tr>' +
      '<td class="mono">' + fmt(r.issued_at) + '</td>' +
      '<td>' + esc(r.actor_label) + '</td>' +
      '<td class="mono">' + esc(r.command) + '</td>' +
      '<td>' + statusPill(r.status) + '</td>' +
      '<td class="mono">' + esc(r.resulting_state || '—') + '</td>' +
      '<td class="num">' + (r.state_echo_ms != null ? r.state_echo_ms + ' ms' : '—') + '</td>' +
      '<td class="reason">' + esc(r.reason || '') + '</td>' +
      '</tr>').join('') : '<tr><td colspan="7" class="empty">No commands in this range.</td></tr>';

    $('states').innerHTML = d.states.length ? d.states.map((r) => {
      const pos = r.attributes && r.attributes.current_position;
      return '<tr>' +
        '<td class="mono">' + fmt(r.observed_at) + '</td>' +
        '<td class="mono">' + esc(r.entity_id) + '</td>' +
        '<td class="mono">' + esc(r.state) + '</td>' +
        '<td class="num">' + (pos != null ? pos : '—') + '</td>' +
        '<td>' + originPill(r.origin_type) + '</td>' +
        '</tr>';
    }).join('') : '<tr><td colspan="5" class="empty">No state changes in this range.</td></tr>';
  } catch (e) {
    $('banner').innerHTML = '<div class="err-banner">Could not read the log: ' + esc(e.message) +
      '. The add-on is running (you are looking at it), so this is the database.</div>';
  }
}

/** Prefill the custom boxes with today in TZ, so they open on something sane. */
function seedCustom() {
  if ($('from').value) return;
  const day = wallNow().toISOString().slice(0, 10);
  $('from').value = day + 'T00:00:00';
  $('to').value = wallNow().toISOString().slice(0, 19);
}

let timer = null;
$('refresh').addEventListener('click', load);
$('limit').addEventListener('change', load);
$('preset').addEventListener('change', () => {
  const custom = $('preset').value === 'custom';
  $('custom').hidden = !custom;
  if (custom) seedCustom();
  load();
});
$('from').addEventListener('change', () => { if ($('preset').value === 'custom') load(); });
$('to').addEventListener('change', () => { if ($('preset').value === 'custom') load(); });
$('auto').addEventListener('change', (e) => {
  clearInterval(timer);
  if (e.target.checked) timer = setInterval(load, 5000);
});
load();
</script>
</body>
</html>`;
