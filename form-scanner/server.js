const express = require("express");
const Database = require("better-sqlite3");
const cron = require("node-cron");
const puppeteer = require("puppeteer");
const path = require("path");
const fs = require("fs");

const app = express();
app.use(express.json());
app.use(express.static("public"));

// ─── DATABASE ────────────────────────────────────────────────────────────────
// /data монтируется как Railway Volume — данные сохраняются между деплоями
const DATA_DIR = process.env.DATA_DIR || "/data";
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "scanner.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS sites (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    url         TEXT NOT NULL UNIQUE,
    interval    INTEGER DEFAULT 60,
    active      INTEGER DEFAULT 1,
    last_scan   TEXT,
    last_status TEXT DEFAULT 'pending',
    created_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS leads (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id     INTEGER NOT NULL,
    site_url    TEXT NOT NULL,
    phone       TEXT,
    name        TEXT,
    email       TEXT,
    raw_data    TEXT,
    form_url    TEXT,
    scanned_at  TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS scan_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id     INTEGER NOT NULL,
    status      TEXT,
    message     TEXT,
    duration_ms INTEGER,
    scanned_at  TEXT DEFAULT (datetime('now'))
  );
`);

// ─── SCANNER ─────────────────────────────────────────────────────────────────

let browserInstance = null;

async function getBrowser() {
  if (!browserInstance || !browserInstance.connected) {
    browserInstance = await puppeteer.launch({
      headless: "new",
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--single-process",
      ],
    });
  }
  return browserInstance;
}

// Ищем телефоны в тексте регуляркой
function extractPhones(text) {
  const phones = new Set();
  const patterns = [
    /(?:\+7|8)[\s\-]?\(?\d{3}\)?[\s\-]?\d{3}[\s\-]?\d{2}[\s\-]?\d{2}/g,
    /\+7\d{10}/g,
    /8\d{10}/g,
  ];
  for (const pat of patterns) {
    const matches = text.match(pat) || [];
    matches.forEach((m) => phones.add(m.replace(/[\s\-()]/g, "")));
  }
  return [...phones];
}

// Нормализация номера
function normalizePhone(phone) {
  let p = phone.replace(/[\s\-()]/g, "");
  if (p.startsWith("8")) p = "+7" + p.slice(1);
  if (p.startsWith("7") && !p.startsWith("+")) p = "+" + p;
  return p;
}

async function scanSite(site) {
  const start = Date.now();
  const capturedLeads = [];

  let browser;
  let page;

  try {
    browser = await getBrowser();
    page = await browser.newPage();

    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36"
    );
    await page.setViewport({ width: 1280, height: 800 });

    // Перехватываем POST-запросы форм
    await page.setRequestInterception(true);

    page.on("request", (req) => {
      if (req.method() === "POST") {
        const body = req.postData() || "";
        const params = new URLSearchParams(body);

        // Ищем телефон в любом поле
        let phone = null;
        let name = null;
        let email = null;
        const rawFields = {};

        for (const [key, val] of params.entries()) {
          rawFields[key] = val;
          const kl = key.toLowerCase();
          if (kl.includes("phone") || kl.includes("tel") || kl.includes("телефон")) {
            phone = val;
          }
          if (kl.includes("name") || kl.includes("имя") || kl.includes("fio")) {
            name = val;
          }
          if (kl.includes("email") || kl.includes("mail")) {
            email = val;
          }
        }

        // Если поле не нашли — ищем телефон в теле как есть
        if (!phone) {
          const found = extractPhones(body);
          if (found.length > 0) phone = found[0];
        }

        if (phone) {
          capturedLeads.push({
            phone: normalizePhone(phone),
            name: name || null,
            email: email || null,
            raw_data: JSON.stringify(rawFields),
            form_url: req.url(),
          });
        }
      }

      req.continue().catch(() => {});
    });

    // Также слушаем ответы для XHR/fetch (Tilda шлёт JSON)
    page.on("response", async (res) => {
      try {
        if (res.request().method() === "POST") {
          const ct = res.headers()["content-type"] || "";
          if (ct.includes("json")) {
            // Ответ получен — значит форма ушла
          }
        }
      } catch (_) {}
    });

    await page.goto(site.url, { waitUntil: "networkidle2", timeout: 30000 });

    // Также парсим страницу на видимые телефоны
    const pageText = await page.evaluate(() => document.body.innerText);
    const visiblePhones = extractPhones(pageText);

    // Сохраняем в БД только перехваченные заявки (не публичные номера)
    const savedLeads = [];
    for (const lead of capturedLeads) {
      try {
        const existing = db
          .prepare("SELECT id FROM leads WHERE site_id=? AND phone=? AND date(scanned_at)=date('now')")
          .get(site.id, lead.phone);

        if (!existing) {
          const ins = db
            .prepare(
              `INSERT INTO leads (site_id, site_url, phone, name, email, raw_data, form_url)
               VALUES (?, ?, ?, ?, ?, ?, ?)`
            )
            .run(site.id, site.url, lead.phone, lead.name, lead.email, lead.raw_data, lead.form_url);
          savedLeads.push({ ...lead, id: ins.lastInsertRowid });
        }
      } catch (e) {
        console.error("DB insert error:", e.message);
      }
    }

    const duration = Date.now() - start;

    // Обновляем статус сайта
    db.prepare("UPDATE sites SET last_scan=datetime('now'), last_status=? WHERE id=?")
      .run("ok", site.id);

    db.prepare("INSERT INTO scan_log (site_id, status, message, duration_ms) VALUES (?,?,?,?)")
      .run(site.id, "ok", `Найдено заявок: ${savedLeads.length}, видимых номеров на странице: ${visiblePhones.length}`, duration);

    console.log(`[SCAN] ${site.url} → ${savedLeads.length} новых заявок за ${duration}ms`);
    return { success: true, leads: savedLeads.length, duration };
  } catch (err) {
    const duration = Date.now() - start;
    console.error(`[SCAN ERROR] ${site.url}:`, err.message);

    db.prepare("UPDATE sites SET last_scan=datetime('now'), last_status=? WHERE id=?")
      .run("error", site.id);
    db.prepare("INSERT INTO scan_log (site_id, status, message, duration_ms) VALUES (?,?,?,?)")
      .run(site.id, "error", err.message, duration);

    return { success: false, error: err.message, duration };
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

// ─── SCHEDULER ───────────────────────────────────────────────────────────────

const activeCrons = {};

function scheduleSite(site) {
  if (activeCrons[site.id]) {
    activeCrons[site.id].stop();
  }

  if (!site.active) return;

  // Конвертируем минуты в cron-выражение
  const minutes = Math.max(1, site.interval || 60);
  const cronExpr = `*/${minutes} * * * *`;

  try {
    activeCrons[site.id] = cron.schedule(cronExpr, () => {
      console.log(`[CRON] Запуск сканирования: ${site.url}`);
      scanSite(site).catch(console.error);
    });
    console.log(`[CRON] Запланировано: ${site.url} каждые ${minutes} мин`);
  } catch (e) {
    console.error(`[CRON ERROR] Не удалось создать задачу для ${site.url}:`, e.message);
  }
}

function initScheduler() {
  const sites = db.prepare("SELECT * FROM sites WHERE active=1").all();
  for (const site of sites) {
    scheduleSite(site);
  }
  console.log(`[CRON] Планировщик запущен, активных сайтов: ${sites.length}`);
}

// ─── API ROUTES ───────────────────────────────────────────────────────────────

// Сайты
app.get("/api/sites", (req, res) => {
  const sites = db.prepare(`
    SELECT s.*,
           (SELECT COUNT(*) FROM leads l WHERE l.site_id = s.id) as leads_count,
           (SELECT COUNT(*) FROM scan_log sl WHERE sl.site_id = s.id) as scans_count
    FROM sites s ORDER BY s.created_at DESC
  `).all();
  res.json(sites);
});

app.post("/api/sites", (req, res) => {
  const { name, url, interval = 60 } = req.body;
  if (!name || !url) return res.status(400).json({ error: "name и url обязательны" });

  try {
    const r = db.prepare(
      "INSERT INTO sites (name, url, interval) VALUES (?, ?, ?)"
    ).run(name, url.trim(), interval);
    const site = db.prepare("SELECT * FROM sites WHERE id=?").get(r.lastInsertRowid);
    scheduleSite(site);
    res.json(site);
  } catch (e) {
    if (e.message.includes("UNIQUE")) {
      return res.status(400).json({ error: "Такой сайт уже добавлен" });
    }
    res.status(500).json({ error: e.message });
  }
});

app.patch("/api/sites/:id", (req, res) => {
  const { name, interval, active } = req.body;
  const site = db.prepare("SELECT * FROM sites WHERE id=?").get(req.params.id);
  if (!site) return res.status(404).json({ error: "Не найден" });

  db.prepare("UPDATE sites SET name=COALESCE(?,name), interval=COALESCE(?,interval), active=COALESCE(?,active) WHERE id=?")
    .run(name, interval, active !== undefined ? (active ? 1 : 0) : null, req.params.id);

  const updated = db.prepare("SELECT * FROM sites WHERE id=?").get(req.params.id);
  scheduleSite(updated);
  res.json(updated);
});

app.delete("/api/sites/:id", (req, res) => {
  const id = req.params.id;
  if (activeCrons[id]) {
    activeCrons[id].stop();
    delete activeCrons[id];
  }
  db.prepare("DELETE FROM sites WHERE id=?").run(id);
  res.json({ ok: true });
});

// Ручное сканирование
app.post("/api/sites/:id/scan", async (req, res) => {
  const site = db.prepare("SELECT * FROM sites WHERE id=?").get(req.params.id);
  if (!site) return res.status(404).json({ error: "Не найден" });
  const result = await scanSite(site);
  res.json(result);
});

// Лиды
app.get("/api/leads", (req, res) => {
  const { site_id, search, limit = 100, offset = 0 } = req.query;
  let query = `
    SELECT l.*, s.name as site_name
    FROM leads l
    JOIN sites s ON s.id = l.site_id
    WHERE 1=1
  `;
  const params = [];

  if (site_id) { query += " AND l.site_id=?"; params.push(site_id); }
  if (search)  { query += " AND (l.phone LIKE ? OR l.name LIKE ? OR l.email LIKE ?)"; 
                 params.push(`%${search}%`, `%${search}%`, `%${search}%`); }

  query += " ORDER BY l.scanned_at DESC LIMIT ? OFFSET ?";
  params.push(Number(limit), Number(offset));

  const leads = db.prepare(query).all(...params);
  const total = db.prepare("SELECT COUNT(*) as c FROM leads").get().c;
  res.json({ leads, total });
});

app.delete("/api/leads/:id", (req, res) => {
  db.prepare("DELETE FROM leads WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

// CSV экспорт
app.get("/api/leads/export", (req, res) => {
  const { site_id } = req.query;
  let query = `
    SELECT l.scanned_at, s.name as site_name, l.site_url, l.phone, l.name, l.email, l.form_url, l.raw_data
    FROM leads l JOIN sites s ON s.id = l.site_id
    WHERE 1=1
  `;
  const params = [];
  if (site_id) { query += " AND l.site_id=?"; params.push(site_id); }
  query += " ORDER BY l.scanned_at DESC";

  const leads = db.prepare(query).all(...params);

  const escape = (v) => {
    if (v == null) return "";
    return `"${String(v).replace(/"/g, '""')}"`;
  };

  const header = ["Дата", "Сайт", "URL", "Телефон", "Имя", "Email", "URL формы", "Сырые данные"];
  const rows = leads.map((l) => [
    l.scanned_at, l.site_name, l.site_url, l.phone, l.name, l.email, l.form_url, l.raw_data
  ].map(escape).join(","));

  const csv = "\uFEFF" + [header.join(","), ...rows].join("\r\n");

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="leads_${Date.now()}.csv"`);
  res.send(csv);
});

// Лог сканирований
app.get("/api/log", (req, res) => {
  const { site_id } = req.query;
  let q = "SELECT sl.*, s.name as site_name FROM scan_log sl JOIN sites s ON s.id=sl.site_id WHERE 1=1";
  const params = [];
  if (site_id) { q += " AND sl.site_id=?"; params.push(site_id); }
  q += " ORDER BY sl.scanned_at DESC LIMIT 50";
  res.json(db.prepare(q).all(...params));
});

// Статистика
app.get("/api/stats", (req, res) => {
  const total_sites  = db.prepare("SELECT COUNT(*) as c FROM sites").get().c;
  const active_sites = db.prepare("SELECT COUNT(*) as c FROM sites WHERE active=1").get().c;
  const total_leads  = db.prepare("SELECT COUNT(*) as c FROM leads").get().c;
  const today_leads  = db.prepare("SELECT COUNT(*) as c FROM leads WHERE date(scanned_at)=date('now')").get().c;
  const total_scans  = db.prepare("SELECT COUNT(*) as c FROM scan_log").get().c;
  const error_scans  = db.prepare("SELECT COUNT(*) as c FROM scan_log WHERE status='error'").get().c;
  res.json({ total_sites, active_sites, total_leads, today_leads, total_scans, error_scans });
});

// ─── START ────────────────────────────────────────────────────────────────────

// Health check для Railway
app.get("/health", (req, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🚀 Form Scanner: http://0.0.0.0:${PORT}\n`);
  initScheduler();
});

process.on("SIGINT", async () => {
  console.log("\nОстановка...");
  if (browserInstance) await browserInstance.close();
  process.exit(0);
});
