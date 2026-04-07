/**
 * Мини-дашборд для просмотра перехваченных номеров
 * Запускай отдельно: node dashboard.js
 * Открывай: http://localhost:3001
 */

const http     = require("http");
const Database = require("better-sqlite3");
const path     = require("path");
const fs       = require("fs");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "captured.db");
const PORT    = process.env.DASH_PORT || 3001;

const db = new Database(DB_PATH);

const server = http.createServer((req, res) => {
  const url = req.url;

  // ── API: список перехватов ──────────────────────────
  if (url === "/api/captures") {
    const rows = db.prepare(`
      SELECT * FROM captures ORDER BY captured_at DESC LIMIT 200
    `).all();
    const total = db.prepare("SELECT COUNT(*) as c FROM captures").get().c;
    const unique = db.prepare("SELECT COUNT(DISTINCT phone) as c FROM captures").get().c;
    const today  = db.prepare(
      "SELECT COUNT(*) as c FROM captures WHERE date(captured_at)=date('now','localtime')"
    ).get().c;

    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ rows, total, unique, today }));
  }

  // ── API: CSV экспорт ────────────────────────────────
  if (url === "/api/export") {
    const rows = db.prepare(
      "SELECT phone, host, url, method, is_https, captured_at FROM captures ORDER BY captured_at DESC"
    ).all();
    const csv = "\uFEFF" + [
      "Телефон,Хост,URL,Метод,HTTPS,Время",
      ...rows.map(r => [r.phone, r.host, r.url, r.method, r.is_https ? "Да" : "Нет", r.captured_at]
        .map(v => `"${String(v).replace(/"/g,'""')}"`).join(","))
    ].join("\r\n");

    res.writeHead(200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="captures_${Date.now()}.csv"`
    });
    return res.end(csv);
  }

  // ── Главная страница ────────────────────────────────
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Phone Interceptor</title>
<style>
  :root{--bg:#0c0d0f;--surf:#131416;--panel:#1a1b1e;--brd:#252629;--txt:#e8e9ec;--mut:#6b6e78;--acc:#e8ff47;--acc2:#47d4ff;--ok:#3ddc84;--err:#ff4d6a;--warn:#ffb347;--mono:'JetBrains Mono',monospace;--sans:system-ui,sans-serif}
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--txt);font-family:var(--sans);font-size:14px}
  .header{background:var(--surf);border-bottom:1px solid var(--brd);padding:14px 24px;display:flex;align-items:center;justify-content:space-between}
  .logo{font-family:var(--mono);font-size:13px;font-weight:700;color:var(--acc);letter-spacing:.1em}
  .content{padding:20px 24px}
  .stats{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:20px}
  .stat{background:var(--panel);border:1px solid var(--brd);border-radius:10px;padding:16px}
  .stat-val{font-family:var(--mono);font-size:28px;font-weight:700;margin-bottom:4px}
  .stat-lbl{font-size:11px;color:var(--mut);text-transform:uppercase;letter-spacing:.05em}
  .card{background:var(--panel);border:1px solid var(--brd);border-radius:12px;overflow:hidden;margin-bottom:16px}
  .card-head{padding:12px 16px;border-bottom:1px solid var(--brd);display:flex;align-items:center;justify-content:space-between}
  .card-title{font-size:13px;font-weight:600}
  .btn{display:inline-flex;align-items:center;gap:6px;padding:6px 14px;border-radius:7px;border:1px solid var(--brd);background:none;color:var(--mut);cursor:pointer;font-size:12px;font-family:var(--sans);transition:.15s}
  .btn:hover{color:var(--txt);border-color:var(--mut)}
  .btn-primary{background:var(--acc);color:#111;border-color:var(--acc)}
  table{width:100%;border-collapse:collapse}
  th{text-align:left;padding:10px 14px;font-size:11px;color:var(--mut);text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid var(--brd)}
  td{padding:10px 14px;border-bottom:1px solid var(--brd);font-size:13px}
  tr:last-child td{border:none}
  tr:hover{background:rgba(255,255,255,.025)}
  .phone{font-family:var(--mono);font-weight:700;color:var(--acc2);font-size:14px}
  .host{color:var(--mut);font-size:12px}
  .badge{display:inline-block;padding:2px 7px;border-radius:10px;font-size:11px;font-weight:600}
  .badge-ok{background:rgba(61,220,132,.15);color:var(--ok)}
  .badge-err{background:rgba(255,77,106,.15);color:var(--err)}
  .live{width:8px;height:8px;background:var(--ok);border-radius:50%;display:inline-block;animation:pulse 1.5s infinite;box-shadow:0 0 6px var(--ok)}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
  .empty{text-align:center;padding:48px;color:var(--mut)}
  .copy-btn{background:none;border:none;cursor:pointer;color:var(--mut);padding:2px 6px;border-radius:4px;font-size:11px;transition:.1s}
  .copy-btn:hover{color:var(--acc);background:rgba(232,255,71,.1)}
  .filter-row{display:flex;gap:10px;padding:10px 14px;border-bottom:1px solid var(--brd)}
  input.search{background:var(--surf);border:1px solid var(--brd);border-radius:6px;padding:7px 12px;color:var(--txt);font-size:13px;outline:none;flex:1;font-family:var(--sans)}
  input.search:focus{border-color:var(--acc)}
  input.search::placeholder{color:var(--mut)}
</style>
</head>
<body>
<div class="header">
  <div class="logo">⬡ PHONE INTERCEPTOR</div>
  <div style="display:flex;gap:10px;align-items:center">
    <span class="live"></span>
    <span style="font-size:12px;color:var(--mut)">Live</span>
    <button class="btn btn-primary" onclick="exportCsv()">⬇ CSV</button>
    <button class="btn" onclick="load()">↻ Обновить</button>
  </div>
</div>

<div class="content">
  <div class="stats" id="stats">
    <div class="stat"><div class="stat-val">—</div><div class="stat-lbl">Всего перехватов</div></div>
    <div class="stat"><div class="stat-val" style="color:var(--ok)">—</div><div class="stat-lbl">Уникальных номеров</div></div>
    <div class="stat"><div class="stat-val" style="color:var(--acc)">—</div><div class="stat-lbl">Сегодня</div></div>
  </div>

  <div class="card">
    <div class="card-head">
      <span class="card-title">📞 Перехваченные номера</span>
      <button class="btn" onclick="copyAll()">📋 Скопировать все</button>
    </div>
    <div class="filter-row">
      <input class="search" id="search" placeholder="🔍 Поиск по номеру или домену..." oninput="filter()">
    </div>
    <div id="table-wrap"><div class="empty">Запусти прокси и заполни форму на сайте</div></div>
  </div>
</div>

<script>
let allData = [];

async function load() {
  const r = await fetch('/api/captures');
  const d = await r.json();
  allData = d.rows;

  const stats = document.getElementById('stats').children;
  stats[0].querySelector('.stat-val').textContent = d.total;
  stats[1].querySelector('.stat-val').textContent = d.unique;
  stats[2].querySelector('.stat-val').textContent = d.today;

  filter();
}

function filter() {
  const q = document.getElementById('search').value.toLowerCase();
  const rows = allData.filter(r =>
    !q || r.phone.includes(q) || (r.host||'').toLowerCase().includes(q)
  );
  renderTable(rows);
}

function renderTable(rows) {
  const wrap = document.getElementById('table-wrap');
  if (!rows.length) {
    wrap.innerHTML = '<div class="empty">Нет перехватов</div>';
    return;
  }
  wrap.innerHTML = \`
    <table>
      <thead><tr>
        <th>Телефон</th><th>Хост</th><th>Метод</th><th>HTTPS</th><th>Время</th><th></th>
      </tr></thead>
      <tbody>
        \${rows.map(r => \`
          <tr>
            <td><span class="phone">\${r.phone}</span></td>
            <td class="host">\${r.host||'—'}</td>
            <td>\${r.method||'—'}</td>
            <td>\${r.is_https ? '<span class="badge badge-ok">✓ HTTPS</span>' : '<span class="badge badge-err">✗ HTTP</span>'}</td>
            <td class="host">\${r.captured_at}</td>
            <td><button class="copy-btn" onclick="copy('\${r.phone}')">копировать</button></td>
          </tr>
        \`).join('')}
      </tbody>
    </table>
  \`;
}

function copy(text) {
  navigator.clipboard.writeText(text);
}

function copyAll() {
  const phones = [...new Set(allData.map(r => r.phone))].join('\\n');
  navigator.clipboard.writeText(phones);
  alert('Скопировано ' + new Set(allData.map(r=>r.phone)).size + ' номеров');
}

function exportCsv() {
  window.open('/api/export', '_blank');
}

load();
setInterval(load, 5000);
</script>
</body>
</html>`);
});

server.listen(PORT, () => {
  console.log(`\n📊 Дашборд: http://localhost:${PORT}`);
  console.log(`   Обновляется каждые 5 секунд\n`);
});
