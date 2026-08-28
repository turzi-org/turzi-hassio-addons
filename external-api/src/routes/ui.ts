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
import { asyncHandler } from '../middleware/errors';

const MAX_ROWS = 500;

interface Summary extends RowDataPacket {
    total: number;
    confirmed: number;
    failed: number;
    actors: string | null;
    last_at: Date | null;
}

export function uiRouter(pool: Pool, config: Config): Router {
    const router = Router();

    router.get('/data', asyncHandler(async (req, res) => {
        const raw = Number(req.query.limit ?? 100);
        const limit = Number.isInteger(raw) && raw > 0 && raw <= MAX_ROWS ? raw : 100;
        // Interpolated, not bound: validated as an integer above, and MariaDB
        // rejects a placeholder in LIMIT on a prepared statement.
        const [commands] = await pool.execute<RowDataPacket[]>(
            `SELECT command_id, entity_id, command, actor_label, status, reason,
                    resulting_state, publish_ms, state_echo_ms, issued_at
               FROM command_log ORDER BY issued_at DESC LIMIT ${limit}`,
        );
        const [states] = await pool.execute<RowDataPacket[]>(
            `SELECT entity_id, state, attributes, origin_type, origin_command_id, observed_at
               FROM state_log ORDER BY observed_at DESC, id DESC LIMIT ${limit}`,
        );
        const [[summary]] = await pool.execute<Summary[]>(
            `SELECT COUNT(*) AS total,
                    SUM(status IN ('confirmed','executed')) AS confirmed,
                    SUM(status = 'failed') AS failed,
                    GROUP_CONCAT(DISTINCT actor_label ORDER BY actor_label) AS actors,
                    MAX(issued_at) AS last_at
               FROM command_log`,
        );

        res.json({
            house_id: config.houseId,
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
      <label>Rows
        <select id="limit">
          <option>50</option><option selected>100</option><option>250</option><option>500</option>
        </select>
      </label>
      <label><input type="checkbox" id="auto"> auto</label>
      <button id="refresh" type="button">Refresh</button>
    </div>
  </header>

  <div id="banner"></div>
  <div class="cards" id="cards"></div>

  <h2>Commands issued through this API</h2>
  <div class="panel"><div class="scroll"><table>
    <thead><tr><th>When (UTC)</th><th>Actor</th><th>Command</th><th>Status</th><th>Result</th><th>Echo</th><th>Reason</th></tr></thead>
    <tbody id="cmds"></tbody>
  </table></div></div>

  <h2>State changes &mdash; including those this API did not cause</h2>
  <div class="panel"><div class="scroll"><table>
    <thead><tr><th>When (UTC)</th><th>Entity</th><th>State</th><th>Position</th><th>Caused by</th></tr></thead>
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
const when = (v) => v ? String(v).replace('T', ' ').replace(/\\..*$/, '').replace('Z','') : '—';

function statusPill(s) {
  const cls = s === 'confirmed' ? 'p-ok' : s === 'executed' ? 'p-warn' : s === 'failed' ? 'p-err' : 'p-mute';
  return '<span class="pill ' + cls + '">' + esc(s) + '</span>';
}
function originPill(o) {
  const cls = o === 'external_api' ? 'p-ok' : o === 'core_user' ? 'p-warn' : o === 'automation' ? 'p-warn' : 'p-mute';
  return '<span class="pill ' + cls + '">' + esc(o) + '</span>';
}

async function load() {
  $('banner').innerHTML = '';
  try {
    const res = await fetch('./data?limit=' + $('limit').value, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const d = await res.json();

    $('site').textContent = d.house_id;
    const s = d.summary || {};
    $('cards').innerHTML = [
      ['Commands', s.total ?? 0, ''],
      ['Succeeded', s.confirmed ?? 0, ''],
      ['Failed', s.failed ?? 0, ''],
      ['Callers', s.actors || '—', 'small'],
      ['Last command', when(s.last_at), 'small'],
    ].map(([k, v, cls]) =>
      '<div class="card"><div class="k">' + k + '</div><div class="v ' + (cls||'') + '">' + esc(v) + '</div></div>'
    ).join('');

    $('cmds').innerHTML = d.commands.length ? d.commands.map((r) =>
      '<tr>' +
      '<td class="mono">' + when(r.issued_at) + '</td>' +
      '<td>' + esc(r.actor_label) + '</td>' +
      '<td class="mono">' + esc(r.command) + '</td>' +
      '<td>' + statusPill(r.status) + '</td>' +
      '<td class="mono">' + esc(r.resulting_state || '—') + '</td>' +
      '<td class="num">' + (r.state_echo_ms != null ? r.state_echo_ms + ' ms' : '—') + '</td>' +
      '<td class="reason">' + esc(r.reason || '') + '</td>' +
      '</tr>').join('') : '<tr><td colspan="7" class="empty">No commands recorded yet.</td></tr>';

    $('states').innerHTML = d.states.length ? d.states.map((r) => {
      const pos = r.attributes && r.attributes.current_position;
      return '<tr>' +
        '<td class="mono">' + when(r.observed_at) + '</td>' +
        '<td class="mono">' + esc(r.entity_id) + '</td>' +
        '<td class="mono">' + esc(r.state) + '</td>' +
        '<td class="num">' + (pos != null ? pos : '—') + '</td>' +
        '<td>' + originPill(r.origin_type) + '</td>' +
        '</tr>';
    }).join('') : '<tr><td colspan="5" class="empty">No state changes recorded yet.</td></tr>';
  } catch (e) {
    $('banner').innerHTML = '<div class="err-banner">Could not read the log: ' + esc(e.message) +
      '. The add-on is running (you are looking at it), so this is the database.</div>';
  }
}

let timer = null;
$('refresh').addEventListener('click', load);
$('limit').addEventListener('change', load);
$('auto').addEventListener('change', (e) => {
  clearInterval(timer);
  if (e.target.checked) timer = setInterval(load, 5000);
});
load();
</script>
</body>
</html>`;
