/**
 * PHONE MITM PROXY
 * ─────────────────────────────────────────────────────
 * Запускает прокси-сервер на порту 8080.
 * Настрой браузер/устройство на этот прокси —
 * все POST-запросы с телефонами будут перехвачены.
 * ─────────────────────────────────────────────────────
 */

const Proxy   = require("http-mitm-proxy");
const Database = require("better-sqlite3");
const path    = require("path");
const fs      = require("fs");

// ─── НАСТРОЙКИ ────────────────────────────────────────

const PORT     = process.env.PORT     || 8080;
const DB_PATH  = process.env.DB_PATH  || path.join(__dirname, "captured.db");
const CERT_DIR = process.env.CERT_DIR || path.join(__dirname, ".certs");

// Фильтр: только эти домены (пустой массив = все домены)
const WATCH_DOMAINS = process.env.DOMAINS
  ? process.env.DOMAINS.split(",")
  : []; // [] = перехватывать всё

// ─── ЦВЕТА ────────────────────────────────────────────

const R = s => `\x1b[31m${s}\x1b[0m`;
const G = s => `\x1b[32m${s}\x1b[0m`;
const Y = s => `\x1b[33m${s}\x1b[0m`;
const C = s => `\x1b[36m${s}\x1b[0m`;
const B = s => `\x1b[1m${s}\x1b[0m`;
const D = s => `\x1b[2m${s}\x1b[0m`;

// ─── БАЗА ДАННЫХ ──────────────────────────────────────

const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS captures (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    phone       TEXT NOT NULL,
    host        TEXT,
    url         TEXT,
    method      TEXT,
    body        TEXT,
    is_https    INTEGER DEFAULT 0,
    captured_at TEXT DEFAULT (datetime('now','localtime'))
  );
`);

const insertCapture = db.prepare(`
  INSERT INTO captures (phone, host, url, method, body, is_https)
  VALUES (?, ?, ?, ?, ?, ?)
`);

// ─── REGEX ────────────────────────────────────────────

const PHONE_RE = /(?:\+7|8)[\s\-]?\(?\d{3}\)?[\s\-]?\d{3}[\s\-]?\d{2}[\s\-]?\d{2}/g;

function extractPhones(text) {
  const found = new Set();
  for (const m of (text.match(PHONE_RE) || [])) {
    let p = m.replace(/[\s\-()]/g, "");
    if (p.startsWith("8") && p.length === 11) p = "+7" + p.slice(1);
    if (p.length >= 11) found.add(p);
  }
  return [...found];
}

function shouldWatch(host) {
  if (!WATCH_DOMAINS.length) return true;
  return WATCH_DOMAINS.some(d => host.includes(d));
}

// ─── ПРОКСИ ───────────────────────────────────────────

const proxy = Proxy();

proxy.onError(function (ctx, err) {
  // Тихо игнорируем ошибки сертификатов
  if (err.code === "ECONNRESET" || err.code === "ERR_STREAM_DESTROYED") return;
  console.error(D(`[ERR] ${err.code || err.message}`));
});

proxy.onRequest(function (ctx, callback) {
  const host   = ctx.clientToProxyRequest.headers.host || "";
  const url    = ctx.clientToProxyRequest.url || "";
  const method = ctx.clientToProxyRequest.method || "";

  // Только POST/PUT/PATCH
  if (!["POST", "PUT", "PATCH"].includes(method)) {
    return callback();
  }

  // Фильтр по доменам
  if (!shouldWatch(host)) {
    return callback();
  }

  // Собираем тело запроса
  const chunks = [];

  ctx.onRequestData(function (ctx, chunk, callback) {
    chunks.push(chunk);
    return callback(null, chunk); // пропускаем дальше без изменений
  });

  ctx.onRequestEnd(function (ctx, callback) {
    const body = Buffer.concat(chunks).toString("utf8");

    if (!body) return callback();

    const phones = extractPhones(body);

    if (phones.length > 0) {
      const isHttps = ctx.isSSL ? 1 : 0;
      const fullUrl = `${isHttps ? "https" : "http"}://${host}${url}`;

      console.log(B(R("\n⚡ ТЕЛЕФОН ПЕРЕХВАЧЕН!")));
      console.log(`  ${C("Хост:")}    ${host}`);
      console.log(`  ${C("URL:")}     ${fullUrl}`);
      console.log(`  ${C("Метод:")}   ${method}`);
      console.log(`  ${C("HTTPS:")}   ${isHttps ? G("✓ Зашифровано") : R("✗ Открыто!")}`);

      phones.forEach(phone => {
        console.log(`  ${C("Телефон:")} ${B(G(phone))}`);

        insertCapture.run(phone, host, fullUrl, method, body.slice(0, 1000), isHttps);
      });

      // Краткий дамп тела
      if (process.env.VERBOSE) {
        console.log(D(`  Тело: ${body.slice(0, 200)}`));
      }
      console.log();
    }

    return callback();
  });

  return callback();
});

// ─── ЗАПУСК ───────────────────────────────────────────

if (!fs.existsSync(CERT_DIR)) fs.mkdirSync(CERT_DIR, { recursive: true });

proxy.listen({ port: PORT, sslCaDir: CERT_DIR }, function () {
  console.log(B("\n╔══════════════════════════════════════════╗"));
  console.log(B("║        PHONE MITM PROXY                  ║"));
  console.log(B("╚══════════════════════════════════════════╝\n"));

  console.log(`${G("✓")} Прокси запущен: ${B(`http://127.0.0.1:${PORT}`)}`);
  console.log(`${G("✓")} База данных:    ${B(DB_PATH)}`);
  console.log(`${G("✓")} Сертификаты:    ${B(CERT_DIR)}\n`);

  console.log(Y("═══ НАСТРОЙКА БРАУЗЕРА ════════════════════"));
  console.log(`  1. Открой настройки браузера → Прокси`);
  console.log(`  2. HTTP Proxy:  ${B("127.0.0.1")}  Порт: ${B(PORT)}`);
  console.log(`  3. HTTPS Proxy: ${B("127.0.0.1")}  Порт: ${B(PORT)}\n`);

  console.log(Y("═══ УСТАНОВКА СЕРТИФИКАТА (для HTTPS) ═════"));
  const certFile = path.join(CERT_DIR, "certs", "ca.pem");
  console.log(`  1. Открой сайт ${B("http://mitm.it")} через прокси`);
  console.log(`  2. Скачай и установи сертификат для своей ОС`);
  console.log(`     ИЛИ найди файл: ${B(certFile)}`);
  console.log(`     и добавь в доверенные сертификаты браузера\n`);

  console.log(Y("═══ ФИЛЬТР ДОМЕНОВ ════════════════════════"));
  if (WATCH_DOMAINS.length) {
    console.log(`  Слежу только за: ${B(WATCH_DOMAINS.join(", "))}`);
  } else {
    console.log(`  Слежу за ${B("всеми")} доменами`);
    console.log(D(`  Чтобы фильтровать: DOMAINS=site.ru,site2.ru node proxy.js`));
  }

  console.log(`\n${G("Жду запросов...")} ${D("(Ctrl+C для остановки)")}\n`);
});

// ─── CLI ПРОСМОТР ПЕРЕХВАТОВ ──────────────────────────

process.on("SIGUSR1", () => {
  const rows = db.prepare(
    "SELECT phone, host, captured_at FROM captures ORDER BY captured_at DESC LIMIT 20"
  ).all();
  console.log(B("\n── Последние перехваты ──────────────────────"));
  rows.forEach(r => {
    console.log(`  ${G(r.phone)} ${D("←")} ${r.host} ${D(r.captured_at)}`);
  });
  console.log();
});
