// Отчет приходи / разходи с данни от базата на Microinvest Склад Про (SQL Server)
// Node.js 20.12+.  Старт: node server.js   Демо: MOCK=1 node server.js
// Връзката с базата се настройва в .env (вижте .env.example).

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

try { process.loadEnvFile(path.join(__dirname, ".env")); } catch {}

const MOCK = process.env.MOCK === "1";
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || undefined; // 127.0.0.1 = само от този компютър (напр. зад tailscale serve)
// Папка за данните, историята и копията (по подразбиране до server.js; тестовете ползват временна)
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : __dirname;
const DATA_FILE = path.join(DATA_DIR, MOCK ? "data-demo.json" : "data.json");
const HISTORY_DIR = path.join(DATA_DIR, MOCK ? "history-demo" : "history");
const BACKUP_DIR = path.join(DATA_DIR, "backups");
const BACKUP_KEEP_DAYS = 30;
const RECENT_DAYS = 3; // последните N дни винаги се презареждат от базата

// Вход с име и парола. В демо режим е изключен, освен ако DEMO_LOGIN=1.
const AUTH = !MOCK || process.env.DEMO_LOGIN === "1";

// ---------------------------------------------------------------- Данни
const DEFAULT_DATA = {
  settings: {
    objectId: null,          // null = всички обекти
    withVat: true,           // сумите с ДДС
    operationTypes: [2],     // 2 = Продажба
    defaultRevenueColumn: "goods", // къде отиват продажбите от групи без съпоставка
    floatDefault: 8500,      // оборотни пари, предлагани при нулиране
  },
  revenueColumns: [
    { id: "service", name: "Сервиз" },
    { id: "prima", name: "Прима карти" },
    { id: "phones", name: "Телефони" },
    { id: "goods", name: "Стока" },
  ],
  expenseColumns: [
    { id: "misc", name: "Разни", kind: "list" },
    { id: "service", name: "Сервиз" },
    { id: "goods", name: "Стока" },
    { id: "salaries", name: "Заплати" },
    { id: "bills", name: "Сметки" },
    { id: "fuel", name: "Гориво" },
    { id: "phones", name: "Телефони" },
    { id: "eshop", name: "Онлайн магазин" },
  ],
  groupMap: {},        // id на група в Microinvest -> id на колона в Приходи (подгрупите наследяват)
  expenses: {},        // "YYYY-MM-DD" -> { колона: число | [{name, value}] }
  revenueManual: {},   // "YYYY-MM-DD" -> { колона: число }  (ръчни стойности и корекции)
  cache: {},           // "YYYY-MM-DD" -> { byGroup: { групаId: сума }, fetchedAt }
  float: [],           // нулирания на оборотните пари, по дата: [{ date, amount, at }]
  floatBalance: {},    // "YYYY-MM-DD" -> оборотни − разходи в края на деня
  users: [],           // акаунти (всички са администратори): [{ username, salt, hash, createdAt, lastLogin }]
  sessions: {},        // sha256(ключ от бисквитката) -> { username, created, expires }
};

let data = loadData();

function loadData() {
  try {
    const d = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    const { apiBase, apiKey, ...settings } = d.settings || {}; // от старата връзка през HTTP
    return { ...structuredClone(DEFAULT_DATA), ...d, settings: { ...DEFAULT_DATA.settings, ...settings } };
  } catch {
    const d = structuredClone(DEFAULT_DATA);
    if (MOCK) d.groupMap = { 1: "phones", 3: "prima", 4: "service" };
    return d;
  }
}

function saveData() {
  const tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
  fs.renameSync(tmp, DATA_FILE);
}

// ---------------------------------------------------------------- Дати
const pad = (n) => String(n).padStart(2, "0");
const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

function daysBetween(from, to) {
  const out = [];
  for (let d = parse(from); fmt(d) <= to; d.setDate(d.getDate() + 1)) out.push(fmt(d));
  return out;
}

// ---------------------------------------------------------------- Резервни копия
// Всеки ден data.json се копира в backups/data-ГГГГ-ММ-ДД.json; пазят се последните 30 дни.
// backup("причина") прави допълнително копие с час, напр. преди промяна на структурата на данните.
let lastBackup = { at: null, file: null, error: null };

function backup(reason) {
  if (MOCK || !fs.existsSync(DATA_FILE)) return null;
  const now = new Date();
  const name = reason ? `data-${fmt(now)}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${reason}.json` : `data-${fmt(now)}.json`;
  const file = path.join(BACKUP_DIR, name);
  if (!reason && fs.existsSync(file)) return null;
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  fs.copyFileSync(DATA_FILE, file);
  lastBackup = { at: now.toISOString(), file: name, error: null };
  return name;
}

function pruneBackups() {
  const limit = new Date(); limit.setDate(limit.getDate() - BACKUP_KEEP_DAYS);
  for (const f of fs.readdirSync(BACKUP_DIR)) {
    const m = /^data-(\d{4}-\d{2}-\d{2})/.exec(f);
    if (m && m[1] < fmt(limit)) fs.unlinkSync(path.join(BACKUP_DIR, f));
  }
}

function dailyBackup() {
  if (MOCK) return;
  try { backup(); if (fs.existsSync(BACKUP_DIR)) pruneBackups(); }
  catch (e) { lastBackup = { ...lastBackup, error: e.message }; console.error("Резервно копие:", e.message); }
}

function backupStatus() {
  if (MOCK) return { mock: true };
  if (!lastBackup.at && fs.existsSync(BACKUP_DIR)) {
    const files = fs.readdirSync(BACKUP_DIR).filter((f) => /^data-\d{4}-\d{2}-\d{2}.*\.json$/.test(f));
    const latest = files.map((f) => ({ f, t: fs.statSync(path.join(BACKUP_DIR, f)).mtime })).sort((a, b) => b.t - a.t)[0];
    if (latest) lastBackup = { ...lastBackup, at: latest.t.toISOString(), file: latest.f };
  }
  return { ...lastBackup, dir: BACKUP_DIR, keepDays: BACKUP_KEEP_DAYS };
}

// ---------------------------------------------------------------- История
// Един файл на месец: history/ГГГГ-ММ.jsonl, по един запис на ред. Само се добавя, не се променя.
// kind "change" — промяна от потребител; kind "sync" — четене от базата на Microinvest.
function logHistory(entry) {
  try {
    const at = new Date();
    fs.mkdirSync(HISTORY_DIR, { recursive: true });
    fs.appendFileSync(path.join(HISTORY_DIR, fmt(at).slice(0, 7) + ".jsonl"), JSON.stringify({ at: at.toISOString(), ...entry }) + "\n");
  } catch (e) { console.error("История:", e.message); }
}

const who = (user) => (user ? { user: user.login, name: user.name } : {});
const audit = (user, action, text, extra = {}) => logHistory({ kind: "change", ...who(user), action, text, ...extra });

function readHistory(from, to, kind, limit = 2000) {
  const months = new Set(daysBetween(from, to).map((d) => d.slice(0, 7)));
  const out = [];
  for (const mo of [...months].sort().reverse()) {
    let text;
    try { text = fs.readFileSync(path.join(HISTORY_DIR, mo + ".jsonl"), "utf8"); } catch { continue; }
    const lines = text.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i]) continue;
      let e; try { e = JSON.parse(lines[i]); } catch { continue; }
      const day = fmt(new Date(e.at));
      if (day < from || day > to || (kind && e.kind !== kind)) continue;
      out.push(e);
      if (out.length >= limit) return { entries: out, truncated: true };
    }
  }
  return { entries: out, truncated: false };
}

// ---------------------------------------------------------------- Акаунти и вход
// Всички акаунти са администратори. Паролите се пазят само като scrypt хеш със сол.
// След вход браузърът получава бисквитка (HttpOnly, SameSite=Strict) със случаен ключ;
// в data.json се пази само SHA-256 на ключа. Сесията важи 30 дни.
const SESSION_DAYS = 30;
const COOKIE = "payroll_session";
const MAX_FAILS = 5, LOCK_MINUTES = 5;
const fails = new Map(); // потребител -> { count, until }

const normUser = (s) => String(s || "").trim().toLowerCase();
const tokenId = (t) => crypto.createHash("sha256").update(t).digest("hex");
const findUser = (name) => data.users.find((u) => u.username === normUser(name));

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString("hex") };
}

function passwordOk(user, password) {
  const h = crypto.scryptSync(String(password || ""), user.salt, 64);
  return crypto.timingSafeEqual(h, Buffer.from(user.hash, "hex"));
}

function checkNewUser(username, password) {
  const u = normUser(username);
  if (!/^[\p{L}\p{N}._-]{2,32}$/u.test(u)) throw new Error("Името трябва да е от 2 до 32 букви, цифри, точка, тире или долна черта, без интервали");
  checkPassword(password);
  return u;
}

function checkPassword(password) {
  if (String(password || "").length < 8) throw new Error("Паролата трябва да е поне 8 знака");
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setSessionCookie(req, res, token, maxAge) {
  const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`);
}

function startSession(req, res, user) {
  const now = Date.now();
  for (const [id, s] of Object.entries(data.sessions)) if (s.expires < now) delete data.sessions[id];
  const token = crypto.randomBytes(32).toString("base64url");
  data.sessions[tokenId(token)] = { username: user.username, created: now, expires: now + SESSION_DAYS * 864e5 };
  user.lastLogin = new Date(now).toISOString();
  saveData();
  setSessionCookie(req, res, token, SESSION_DAYS * 86400);
}

function sessionOf(req) {
  const t = parseCookies(req)[COOKIE];
  if (!t) return null;
  const id = tokenId(t), s = data.sessions[id];
  return s && s.expires > Date.now() ? { id, ...s } : null;
}

// { login, name, sessionId } или null
function userOf(req) {
  if (!AUTH) return null;
  const s = sessionOf(req);
  const u = s && findUser(s.username);
  return u ? { login: u.username, name: u.username, sessionId: s.id } : null;
}

const dropSessions = (username, keepId) => {
  for (const [id, s] of Object.entries(data.sessions)) if (s.username === username && id !== keepId) delete data.sessions[id];
};

const usersList = () => data.users.map(({ username, createdAt, lastLogin }) => ({ username, createdAt, lastLogin }));

// ---------------------------------------------------------------- База на Microinvest
// Чете се само от Operations, Goods и GoodsGroups. Продажбите се сумират в базата по ден и група.
const sql = MOCK ? null : require("mssql");

// Сървърът може да е "localhost" или "localhost\SQLEXPRESS" (именувана инстанция)
function sqlConfig() {
  const e = process.env;
  const [server, instanceName] = String(e.MI_SQL_SERVER || "localhost").split("\\");
  return {
    server, database: e.MI_SQL_DATABASE, user: e.MI_SQL_USER, password: e.MI_SQL_PASSWORD,
    port: e.MI_SQL_PORT ? Number(e.MI_SQL_PORT) : undefined,
    options: { instanceName, encrypt: e.MI_SQL_ENCRYPT === "1", trustServerCertificate: true },
    pool: { max: 3, min: 0, idleTimeoutMillis: 60000 },
    connectionTimeout: 10000, requestTimeout: 60000,
  };
}

function connectionInfo() {
  if (MOCK) return { mock: true };
  const e = process.env;
  return { server: e.MI_SQL_SERVER || "localhost", database: e.MI_SQL_DATABASE || "", user: e.MI_SQL_USER || "",
    configured: !!(e.MI_SQL_DATABASE && e.MI_SQL_USER && e.MI_SQL_PASSWORD) };
}

function friendlySqlError(e) {
  const c = connectionInfo();
  if (e.code === "ELOGIN") return `SQL Server отказа входа на „${c.user}“. Проверете потребителя и паролата в .env и дали има достъп до базата ${c.database}.`;
  const instance = c.server.includes("\\") && !process.env.MI_SQL_PORT;
  if (e.code === "EINSTLOOKUP" || (instance && ["ESOCKET", "ETIMEOUT"].includes(e.code)))
    return `Не е намерена инстанцията ${c.server}. Пуснете услугата SQL Server Browser или задайте MI_SQL_PORT в .env, и проверете дали е включен протоколът TCP/IP (SQL Server Configuration Manager).`;
  if (e.code === "ESOCKET" || e.code === "ETIMEOUT") return `Няма връзка със SQL Server на ${c.server}. Проверете дали е включен протоколът TCP/IP (SQL Server Configuration Manager) и порта.`;
  return `Грешка от базата: ${e.message}`;
}

let pool = null;
async function query(text, params = {}) {
  if (!connectionInfo().configured) throw new Error("Връзката с базата не е настроена. Попълнете MI_SQL_DATABASE, MI_SQL_USER и MI_SQL_PASSWORD в .env и рестартирайте програмата.");
  try {
    pool ||= new sql.ConnectionPool(sqlConfig()).connect();
    const req = (await pool).request();
    for (const [k, [type, v]] of Object.entries(params)) req.input(k, type, v);
    return (await req.query(text)).recordset;
  } catch (e) {
    console.error("SQL:", e.code || "", e.message);
    const p = pool; pool = null; (await p?.catch(() => null))?.close().catch(() => {});
    throw new Error(friendlySqlError(e));
  }
}

// Датите се подават като параметри от тип date, без превръщане от текст в SQL.
// Драйверът праща Date в UTC, затова денят се създава в UTC и се чете обратно в UTC.
const toSqlDate = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const fromSqlDate = (d) => d.toISOString().slice(0, 10);

// Общи условия: вид операция, период (дати като "YYYY-MM-DD"), обект
function salesFilter(from, to) {
  const s = data.settings;
  const params = { from: [sql.Date, toSqlDate(from)], to: [sql.Date, toSqlDate(to)], vat: [sql.Bit, s.withVat] };
  const types = s.operationTypes.map((t, i) => { params["t" + i] = [sql.Int, t]; return "@t" + i; });
  let where = `o.OperType IN (${types.join(", ")})
    AND o.[Date] >= @from AND o.[Date] < DATEADD(day, 1, @to)`;
  if (s.objectId != null) { where += " AND o.ObjectID = @obj"; params.obj = [sql.Int, s.objectId]; }
  return { where, params };
}
// Реалната цена на продажбата (с корекциите от панела за продажба), с или без ДДС
const AMOUNT = "o.Qtty * (o.PriceOut + CASE WHEN @vat = 1 THEN o.VATOut ELSE 0 END)";

const source = MOCK ? null : {
  groups: () => query("SELECT ID AS id, Code AS code, Name AS name FROM GoodsGroups"),

  // [{ day, groupId, amount }]
  async salesByGroup(from, to) {
    const { where, params } = salesFilter(from, to);
    const rows = await query(`SELECT CAST(o.[Date] AS date) AS day, g.GroupID AS groupId, SUM(${AMOUNT}) AS amount
      FROM Operations o LEFT JOIN Goods g ON g.ID = o.GoodID
      WHERE ${where}
      GROUP BY CAST(o.[Date] AS date), g.GroupID`, params);
    return rows.map((r) => ({ ...r, day: fromSqlDate(r.day) }));
  },

  // [{ goodId, name, code, groupId, doc, qtty, amount }] за един ден
  saleLines(date) {
    const { where, params } = salesFilter(date, date);
    return query(`SELECT o.GoodID AS goodId, g.Name AS name, g.Code AS code, g.GroupID AS groupId, o.Acct AS doc,
        SUM(o.Qtty) AS qtty, SUM(${AMOUNT}) AS amount
      FROM Operations o LEFT JOIN Goods g ON g.ID = o.GoodID
      WHERE ${where}
      GROUP BY o.GoodID, g.Name, g.Code, g.GroupID, o.Acct`, params);
  },
};

// Основните групи по код; подгрупите (AER…, AES…) ги наследяват
const DEFAULT_GROUP_CODES = { AES: "service", AEU: "prima", AET: "phones", AER: "goods" };

// Групи артикули (кеширани 10 минути)
let catalog = { groups: [], loadedAt: 0 };
async function loadCatalog(force = false, user = null) {
  if (!force && Date.now() - catalog.loadedAt < 10 * 60 * 1000 && catalog.groups.length) return catalog;
  const groups = await fromDb("groups", user, { trigger: force ? "manual" : "auto" }, async () => {
    const g = await (MOCK ? mockSource : source).groups();
    return [g, { rows: g.length }];
  });
  catalog = {
    groups: groups.map((g) => ({ id: g.id, code: String(g.code ?? "").trim(), name: g.name || `Група ${g.id}` }))
      .sort((a, b) => a.code.localeCompare(b.code)),
    loadedAt: Date.now(),
  };
  // При първа връзка свързва основните групи с колоните
  if (!MOCK && !data.groupMapSeeded) {
    for (const g of catalog.groups) if (DEFAULT_GROUP_CODES[g.code]) data.groupMap[g.id] = DEFAULT_GROUP_CODES[g.code];
    data.groupMapSeeded = true;
    saveData();
  }
  return catalog;
}

// Колона в Приходи за дадена група; подгрупите наследяват родителя (по код)
function columnForGroup(groupId) {
  const map = data.groupMap;
  if (map[groupId]) return map[groupId];
  const g = catalog.groups.find((x) => String(x.id) === String(groupId));
  if (g && g.code) {
    const parents = catalog.groups
      .filter((p) => p.code && p.code.length < g.code.length && g.code.startsWith(p.code) && map[p.id])
      .sort((a, b) => b.code.length - a.code.length);
    if (parents.length) return map[parents[0].id];
  }
  return data.settings.defaultRevenueColumn;
}

// Зарежда от базата дните, които липсват в кеша или са скорошни
async function syncRange(from, to, force, user) {
  const today = fmt(new Date());
  const recent = new Date(); recent.setDate(recent.getDate() - RECENT_DAYS);
  const recentFrom = fmt(recent);
  const need = daysBetween(from, to).filter((d) => d <= today && (force || !data.cache[d] || d >= recentFrom));
  if (!need.length) return;

  await loadCatalog(force, user);
  const [a, b] = [need[0], need[need.length - 1]];
  const rows = await fromDb("sales", user, { trigger: force ? "manual" : "auto", from: a, to: b, days: need.length }, async () => {
    const r = await (MOCK ? mockSource : source).salesByGroup(a, b);
    return [r, { rows: r.length, amount: round2(r.reduce((s, x) => s + Number(x.amount || 0), 0)) }];
  });
  const fresh = Object.fromEntries(need.map((d) => [d, { byGroup: {}, fetchedAt: Date.now() }]));
  for (const r of rows) {
    if (!fresh[r.day]) continue;
    const gid = String(r.groupId ?? "none");
    fresh[r.day].byGroup[gid] = round2((fresh[r.day].byGroup[gid] || 0) + Number(r.amount || 0));
  }
  Object.assign(data.cache, fresh);
  saveData();
}

const round2 = (n) => Math.round(n * 100) / 100;

// Изпълнява четене от базата и го записва в историята: какво, кой, за колко време, грешка.
// fn връща [резултат, { rows, amount }].
async function fromDb(what, user, meta, fn) {
  const t0 = Date.now();
  try {
    const [result, info] = await fn();
    logHistory({ kind: "sync", ...who(user), what, ...meta, ...info, ms: Date.now() - t0 });
    return result;
  } catch (e) {
    logHistory({ kind: "sync", ...who(user), what, ...meta, ms: Date.now() - t0, error: e.message });
    throw e;
  }
}

// ---------------------------------------------------------------- Оборотни пари
// Всеки месец оборотните пари се нулират (от 1-во число). Админът се пита на 1-во,
// или на 2-ро, ако 1-во е неделя. Докато не потвърди, остатъкът продължава от предишния месец.

const monthStart = (s) => s.slice(0, 8) + "01";

function resetPromptDay(month) {
  const d = parse(month + "-01");
  if (d.getDay() === 0) d.setDate(2);
  return fmt(d);
}

function expenseTotal(date) {
  const day = data.expenses[date];
  if (!day) return 0;
  let s = 0;
  for (const c of data.expenseColumns) {
    const v = day[c.id];
    s += Array.isArray(v) ? v.reduce((a, i) => a + (i.value || 0), 0) : v || 0;
  }
  return s;
}

function ensureFloat() {
  if (data.float.length) return false;
  data.float.push({ date: monthStart(fmt(new Date())), amount: data.settings.floatDefault, at: Date.now() });
  return true;
}

// Преизчислява остатъка за всеки ден от първото нулиране до днес. Връща true при промяна.
function recomputeFloat() {
  const out = {};
  if (data.float.length) {
    let i = 0, bal = 0;
    for (const d of daysBetween(data.float[0].date, fmt(new Date()))) {
      while (i < data.float.length && data.float[i].date === d) bal = data.float[i++].amount;
      bal = round2(bal - expenseTotal(d));
      out[d] = bal;
    }
  }
  if (JSON.stringify(out) === JSON.stringify(data.floatBalance)) return false;
  data.floatBalance = out;
  return true;
}

function refreshFloat() {
  if (ensureFloat() | recomputeFloat()) saveData();
}

function activeReset() {
  const today = fmt(new Date());
  return data.float.findLast((r) => r.date <= today) || null;
}

function floatStatus() {
  const today = fmt(new Date()), month = today.slice(0, 7);
  const due = today >= resetPromptDay(month) && !data.float.some((r) => r.date.startsWith(month));
  return {
    resets: data.float.map(({ date, amount }) => ({ date, amount })),
    current: activeReset(),
    balance: data.floatBalance[today] ?? null,
    default: data.settings.floatDefault,
    pendingReset: due ? { date: month + "-01" } : null,
  };
}

const balancesFor = (from, to) => Object.fromEntries(daysBetween(from, to).map((d) => [d, data.floatBalance[d] ?? null]));

function buildReport(from, to) {
  const days = daysBetween(from, to).map((date) => {
    const api = {};
    for (const c of data.revenueColumns) api[c.id] = 0;
    const cached = data.cache[date];
    if (cached) {
      for (const [gid, amount] of Object.entries(cached.byGroup)) {
        const col = columnForGroup(gid);
        if (col in api) api[col] += amount;
      }
    }
    for (const k in api) api[k] = round2(api[k]);
    const manual = data.revenueManual[date] || {};
    const revenue = {};
    for (const c of data.revenueColumns) revenue[c.id] = manual[c.id] ?? api[c.id];
    return { date, revenue, revenueApi: api, edited: Object.keys(manual), loaded: !!cached, expenses: data.expenses[date] || {},
      balance: data.floatBalance[date] ?? null };
  });
  return days;
}

function mappedColumns() {
  const set = new Set(Object.values(data.groupMap));
  set.add(data.settings.defaultRevenueColumn);
  return [...set];
}

// ---------------------------------------------------------------- HTTP
function send(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
  });
}

const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(/\s/g, "").replace(",", "."));
  if (!Number.isFinite(n)) throw new Error("Невалидно число: " + v);
  return round2(n);
};

function slug(name, existing) {
  let base = "c" + Date.now().toString(36);
  while (existing.some((c) => c.id === base)) base += "x";
  return base;
}

// Текст за историята
const moneyFmt = new Intl.NumberFormat("bg-BG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dmy = (s) => `${s.slice(8, 10)}.${s.slice(5, 7)}.${s.slice(0, 4)}`;
const showVal = (v) => v == null ? "—"
  : Array.isArray(v) ? `${moneyFmt.format(v.reduce((a, i) => a + (i.value || 0), 0))} (${v.length} бр.)` : moneyFmt.format(v);
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const tableName = (t) => (t === "revenue" ? "Приходи" : "Разходи");

const handlers = {
  "GET /api/state": async (_, __, user) => {
    refreshFloat();
    let groups = catalog.groups, catalogError = null;
    try { groups = (await loadCatalog(false, user)).groups; } catch (e) { catalogError = e.message; }
    return { settings: data.settings, connection: connectionInfo(), revenueColumns: data.revenueColumns, expenseColumns: data.expenseColumns,
      groupMap: data.groupMap, groups, mappedColumns: mappedColumns(), catalogError, mock: MOCK,
      isAdmin: true, // до приложението стигат само администратори
      auth: { enabled: AUTH, user: user && { name: user.name }, users: AUTH ? usersList() : [] },
      backup: backupStatus(), float: floatStatus() };
  },

  "GET /api/report": async (q, _, user) => {
    const from = q.get("from"), to = q.get("to");
    if (!isDate(from) || !isDate(to) || from > to) throw new Error("Невалиден период");
    let syncError = null;
    try { await syncRange(from, to, q.get("force") === "1", user); } catch (e) { syncError = e.message; }
    refreshFloat();
    return { days: buildReport(from, to), syncError, mappedColumns: mappedColumns(), float: floatStatus() };
  },

  // Продажбите от Microinvest за един ден и една колона — за проверка
  "GET /api/detail": async (q, _, user) => {
    const date = q.get("date"), col = q.get("col");
    if (!isDate(date)) throw new Error("Невалидна дата");
    await loadCatalog(false, user);
    const lines = await fromDb("detail", user, { trigger: "manual", from: date, to: date }, async () => {
      const r = await (MOCK ? mockSource : source).saleLines(date);
      return [r, { rows: r.length }];
    });
    const byItem = new Map();
    for (const r of lines) {
      if (columnForGroup(String(r.groupId ?? "none")) !== col) continue;
      const key = String(r.goodId);
      const row = byItem.get(key) || { name: r.name ?? `Артикул ${key}`, code: r.code ?? "", qtty: 0, amount: 0, docs: new Set() };
      row.qtty += Number(r.qtty || 0);
      row.amount += Number(r.amount || 0);
      if (r.doc != null) row.docs.add(r.doc);
      byItem.set(key, row);
    }
    return { lines: [...byItem.values()].map((r) => ({ ...r, qtty: round2(r.qtty), amount: round2(r.amount), docs: [...r.docs] }))
      .sort((a, b) => b.amount - a.amount) };
  },

  "GET /api/history": async (q) => {
    const from = q.get("from"), to = q.get("to"), kind = q.get("kind");
    if (!isDate(from) || !isDate(to) || from > to) throw new Error("Невалиден период");
    return readHistory(from, to, kind === "change" || kind === "sync" ? kind : null);
  },

  "POST /api/expense": async (_, b, user) => {
    if (!isDate(b.date) || !data.expenseColumns.some((c) => c.id === b.col)) throw new Error("Невалидни данни");
    const col = data.expenseColumns.find((c) => c.id === b.col);
    const day = (data.expenses[b.date] ||= {});
    const before = structuredClone(day[b.col] ?? null);
    if (col.kind === "list") {
      const items = (b.items || []).map((i) => ({ name: String(i.name || "").trim(), value: num(i.value) })).filter((i) => i.value !== null);
      if (items.length) day[b.col] = items; else delete day[b.col];
    } else {
      const v = num(b.value);
      if (v === null) delete day[b.col]; else day[b.col] = v;
    }
    const after = day[b.col] ?? null;
    if (!Object.keys(day).length) delete data.expenses[b.date];
    recomputeFloat();
    saveData();
    if (!same(before, after))
      audit(user, "expense", `Разход ${dmy(b.date)} · ${col.name}: ${showVal(before)} → ${showVal(after)}`, { date: b.date, col: b.col, before, after });
    const balances = isDate(b.from) && isDate(b.to) && b.from <= b.to ? balancesFor(b.from, b.to) : {};
    return { ok: true, value: after, balances, float: floatStatus() };
  },

  // action "set" — променя сумата на текущия месец; "reset" — нулира от 1-во число на месеца
  "POST /api/float": async (_, b, user) => {
    const amount = num(b.amount);
    if (amount === null || amount < 0) throw new Error("Въведете сума на оборотните пари");
    let text;
    if (b.action === "set") {
      const r = activeReset();
      if (!r) throw new Error("Няма начална сума на оборотните пари");
      text = `Оборотни пари от ${dmy(r.date)}: ${showVal(r.amount)} → ${showVal(amount)}`;
      r.amount = amount;
    } else if (b.action === "reset") {
      const date = monthStart(fmt(new Date()));
      const r = data.float.find((x) => x.date === date);
      text = `Нулиране на оборотните пари от ${dmy(date)}: ${showVal(amount)}`;
      if (r) Object.assign(r, { amount, at: Date.now() });
      else data.float.push({ date, amount, at: Date.now() });
      data.float.sort((x, y) => x.date.localeCompare(y.date));
    } else throw new Error("Невалидно действие");
    data.settings.floatDefault = amount;
    recomputeFloat();
    saveData();
    audit(user, "float", text, { op: b.action, amount });
    return { ok: true, float: floatStatus() };
  },

  "POST /api/revenue": async (_, b, user) => {
    const col = data.revenueColumns.find((c) => c.id === b.col);
    if (!isDate(b.date) || !col) throw new Error("Невалидни данни");
    const day = (data.revenueManual[b.date] ||= {});
    const before = day[b.col] ?? null;
    const v = num(b.value);
    if (v === null) delete day[b.col]; else day[b.col] = v;
    if (!Object.keys(day).length) delete data.revenueManual[b.date];
    saveData();
    if (!same(before, v)) {
      const show = (x) => (x == null ? "от Microinvest" : showVal(x));
      audit(user, "revenue", `Приход ${dmy(b.date)} · ${col.name}: ${show(before)} → ${show(v)}`, { date: b.date, col: b.col, before, after: v });
    }
    return { ok: true };
  },

  "POST /api/columns": async (_, b, user) => {
    const list = b.table === "revenue" ? data.revenueColumns : b.table === "expense" ? data.expenseColumns : null;
    if (!list) throw new Error("Невалидна таблица");
    const name = String(b.name || "").trim(), where = tableName(b.table);
    let text;
    if (b.action === "add") {
      if (!name) throw new Error("Въведете име на колоната");
      const col = { id: slug(name, list), name };
      if (b.table === "expense" && b.kind === "list") col.kind = "list";
      list.push(col);
      text = `Нова колона в ${where}: „${name}“`;
    } else if (b.action === "rename") {
      const c = list.find((x) => x.id === b.id);
      if (!c || !name) throw new Error("Невалидни данни");
      if (c.name !== name) text = `Преименувана колона в ${where}: „${c.name}“ → „${name}“`;
      c.name = name;
    } else if (b.action === "delete") {
      const i = list.findIndex((x) => x.id === b.id);
      if (i < 0) throw new Error("Няма такава колона");
      if (b.table === "revenue" && data.settings.defaultRevenueColumn === b.id) throw new Error("Това е колоната по подразбиране за продажбите. Изберете друга в Настройки, преди да я изтриете.");
      text = `Изтрита колона в ${where}: „${list[i].name}“`;
      list.splice(i, 1);
      if (b.table === "revenue") for (const g in data.groupMap) if (data.groupMap[g] === b.id) delete data.groupMap[g];
    } else if (b.action === "move") {
      const i = list.findIndex((x) => x.id === b.id), j = i + (b.dir < 0 ? -1 : 1);
      if (i >= 0 && j >= 0 && j < list.length) {
        [list[i], list[j]] = [list[j], list[i]];
        text = `Преместена колона в ${where}: „${list[j].name}“ ${b.dir < 0 ? "наляво" : "надясно"}`;
      }
    } else throw new Error("Невалидно действие");
    if (b.table === "expense") recomputeFloat();
    saveData();
    if (text) audit(user, "columns", text, { table: b.table, op: b.action, id: b.id });
    return { ok: true };
  },

  "POST /api/groupmap": async (_, b, user) => {
    const before = data.groupMap[b.groupId] ?? null;
    if (b.col) data.groupMap[b.groupId] = b.col; else delete data.groupMap[b.groupId];
    saveData();
    if (before !== (b.col || null)) {
      const g = catalog.groups.find((x) => String(x.id) === String(b.groupId));
      const colName = (id) => (id ? data.revenueColumns.find((c) => c.id === id)?.name ?? id : "автоматично");
      audit(user, "groupmap", `Група „${g ? `${g.name} ${g.code}` : b.groupId}“: ${colName(before)} → ${colName(b.col)}`,
        { groupId: b.groupId, before, after: b.col || null });
    }
    return { ok: true };
  },

  "POST /api/settings": async (_, b, user) => {
    const s = data.settings, changes = [];
    if (b.objectId !== undefined) {
      const obj = b.objectId === "" || b.objectId === null ? null : Number(b.objectId);
      if (obj !== null && !Number.isInteger(obj)) throw new Error("Обектът трябва да е число (ID)");
      if (obj !== s.objectId) { changes.push(`обект ${s.objectId ?? "всички"} → ${obj ?? "всички"}`); s.objectId = obj; data.cache = {}; }
    }
    if (b.withVat !== undefined && !!b.withVat !== s.withVat) {
      s.withVat = !!b.withVat; data.cache = {};
      changes.push(s.withVat ? "суми с ДДС" : "суми без ДДС");
    }
    if (b.operationTypes !== undefined) {
      const t = String(b.operationTypes).split(/[ ,;]+/).map(Number).filter((n) => Number.isInteger(n) && n > 0);
      if (!t.length) throw new Error("Въведете поне един тип операция");
      if (t.join() !== s.operationTypes.join()) { changes.push(`типове операции ${s.operationTypes.join(", ")} → ${t.join(", ")}`); data.cache = {}; }
      s.operationTypes = t;
    }
    if (b.defaultRevenueColumn !== undefined && b.defaultRevenueColumn !== s.defaultRevenueColumn) {
      const colName = (id) => data.revenueColumns.find((c) => c.id === id)?.name ?? id;
      changes.push(`колона по подразбиране „${colName(s.defaultRevenueColumn)}“ → „${colName(b.defaultRevenueColumn)}“`);
      s.defaultRevenueColumn = b.defaultRevenueColumn;
    }
    saveData();
    if (changes.length) audit(user, "settings", "Настройки: " + changes.join("; "));
    return { ok: true };
  },

  "POST /api/clear-cache": async (_, __, user) => {
    data.cache = {}; catalog.loadedAt = 0; saveData();
    audit(user, "cache", "Изтрити запазените продажби, ще се изтеглят наново от Microinvest");
    return { ok: true };
  },

  "POST /api/backup": async (_, __, user) => {
    if (MOCK) throw new Error("В демо режим не се правят резервни копия");
    let file;
    try { file = backup("manual"); } catch (e) { lastBackup = { ...lastBackup, error: e.message }; throw new Error("Копието не е направено: " + e.message); }
    audit(user, "backup", `Ръчно резервно копие: ${file}`);
    return { ok: true, backup: backupStatus() };
  },
};

// Достъпни без вход: проверка на сесията, вход, първи акаунт, изход
const publicHandlers = {
  "GET /api/session": async (_, __, user) => ({ auth: AUTH, user: user && { name: user.name }, setup: AUTH && !data.users.length }),

  "POST /api/login": async (_, b, __, req, res) => {
    const name = normUser(b.username), f = fails.get(name), now = Date.now();
    if (f?.until > now) throw new Error(`Твърде много грешни опити. Опитайте отново след ${Math.ceil((f.until - now) / 60000)} мин.`);
    const user = findUser(name);
    if (!user || !passwordOk(user, b.password)) {
      const count = (f && !f.until ? f.count : 0) + 1; // след изтекло заключване броенето започва отначало
      if (fails.size > 1000) fails.clear();
      fails.set(name, count >= MAX_FAILS ? { count: 0, until: now + LOCK_MINUTES * 60000 } : { count, until: 0 });
      logHistory({ kind: "change", action: "login-failed", text: `Неуспешен вход с име „${name}“` });
      throw new Error("Грешно име или парола");
    }
    fails.delete(name);
    startSession(req, res, user);
    audit({ login: user.username, name: user.username }, "login", "Вход");
    return { ok: true };
  },

  // Първият акаунт се създава от страницата, само докато няма нито един
  "POST /api/setup": async (_, b, __, req, res) => {
    if (!AUTH || data.users.length) throw new Error("Вече има създаден акаунт");
    const username = checkNewUser(b.username, b.password);
    const user = { username, ...hashPassword(b.password), createdAt: new Date().toISOString() };
    data.users.push(user);
    startSession(req, res, user);
    audit({ login: username, name: username }, "users", `Създаден първи акаунт „${username}“`);
    return { ok: true };
  },

  "POST /api/logout": async (_, __, user, req, res) => {
    const s = sessionOf(req);
    if (s) { delete data.sessions[s.id]; saveData(); }
    setSessionCookie(req, res, "", 0);
    if (user) audit(user, "logout", "Изход");
    return { ok: true };
  },
};

// Акаунти: добавяне, смяна на парола, изтриване
handlers["POST /api/users"] = async (_, b, user) => {
  if (!AUTH) throw new Error("В демо режим няма акаунти");
  if (b.action === "add") {
    const username = checkNewUser(b.username, b.password);
    if (findUser(username)) throw new Error(`Вече има акаунт „${username}“`);
    data.users.push({ username, ...hashPassword(b.password), createdAt: new Date().toISOString() });
    saveData();
    audit(user, "users", `Нов акаунт „${username}“`);
  } else if (b.action === "password") {
    const target = findUser(b.username);
    if (!target) throw new Error("Няма такъв акаунт");
    checkPassword(b.password);
    Object.assign(target, hashPassword(b.password));
    dropSessions(target.username, user.sessionId); // излиза от другите устройства
    saveData();
    audit(user, "users", target.username === user.login ? "Смяна на собствената парола" : `Смяна на паролата на „${target.username}“`);
  } else if (b.action === "delete") {
    const target = findUser(b.username);
    if (!target) throw new Error("Няма такъв акаунт");
    if (target.username === user.login) throw new Error("Не можете да изтриете собствения си акаунт");
    data.users = data.users.filter((u) => u !== target);
    dropSessions(target.username);
    saveData();
    audit(user, "users", `Изтрит акаунт „${target.username}“`);
  } else throw new Error("Невалидно действие");
  return { ok: true, users: usersList() };
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const key = `${req.method} ${url.pathname}`;
  const user = userOf(req);
  const h = publicHandlers[key] || handlers[key];
  if (h) {
    try {
      if (AUTH && !user && !publicHandlers[key]) return send(res, 401, { error: "Влезте отново", login: true });
      // Само JSON: така чужда страница не може да прати заявка от браузъра на влязъл потребител (CSRF)
      if (req.method === "POST" && !String(req.headers["content-type"] || "").startsWith("application/json"))
        return send(res, 415, { error: "Очаква се JSON" });
      const body = req.method === "POST" ? await readBody(req) : null;
      send(res, 200, await h(url.searchParams, body, user, req, res));
    } catch (e) {
      send(res, 400, { error: e.message });
    }
    return;
  }
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    const page = [path.join(__dirname, "public", "index.html"), path.join(__dirname, "index.html")].find((p) => fs.existsSync(p));
    if (!page) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`Липсва index.html. Сложете го в ${path.join(__dirname, "public")}`);
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    fs.createReadStream(page).pipe(res);
    return;
  }
  res.writeHead(404); res.end();
});

dailyBackup();
setInterval(dailyBackup, 60 * 60 * 1000).unref();

server.listen(PORT, HOST, () => {
  console.log(`Отчет: http://${HOST || "localhost"}:${server.address().port}`);
  const c = connectionInfo();
  console.log(MOCK ? "Демо режим с примерни данни" : c.configured ? `Microinvest: ${c.server}, база ${c.database}, потребител ${c.user}`
    : "Внимание: връзката с базата не е настроена (вижте .env.example)");
  console.log(`Данните се пазят в ${DATA_FILE}`);
  if (AUTH) console.log(data.users.length ? `Акаунти: ${data.users.map((u) => u.username).join(", ")}`
    : "Няма акаунти. Отворете програмата в браузъра и създайте първия.");
});

// ---------------------------------------------------------------- Демо данни
const MOCK_GROUPS = [
  { id: 1, code: "001", name: "Телефони" }, { id: 2, code: "002", name: "Аксесоари" },
  { id: 5, code: "002001", name: "Кабели и зарядни" }, { id: 3, code: "003", name: "Прима карти" },
  { id: 4, code: "004", name: "Сервизни услуги" },
];
const MOCK_ITEMS = [
  [1, "Samsung Galaxy A55", 1, 649], [2, "iPhone 15 128GB", 1, 1599], [3, "Redmi Note 13", 1, 389],
  [4, "Калъф силикон", 2, 15], [5, "Протектор стъкло", 2, 20], [6, "USB-C кабел 1м", 5, 12.9],
  [7, "Зарядно 20W", 5, 29], [8, "Прима карта 10", 3, 10], [9, "Прима карта 20", 3, 20],
  [10, "Смяна на дисплей", 4, 180], [11, "Смяна на батерия", 4, 70], [12, "Диагностика", 4, 15],
].map(([id, name, groupId, price]) => ({ id, code: String(100 + id), name, groupId, price }));

// Псевдослучайни продажби, еднакви за дадена дата
function mockLines(date) {
  let seed = Number(date.replace(/-/g, "")), doc = seed % 1000 * 100;
  const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
  const lines = [];
  const n = parse(date).getDay() === 0 ? 3 : 8 + Math.floor(rnd() * 10);
  for (let i = 0; i < n; i++) {
    const it = MOCK_ITEMS[Math.floor(rnd() * MOCK_ITEMS.length)];
    if (it.groupId === 1 && rnd() > 0.3) continue;
    const qtty = 1 + Math.floor(rnd() * (it.price < 30 ? 3 : 1));
    const price = data.settings.withVat ? it.price : round2(it.price / 1.2);
    lines.push({ goodId: it.id, name: it.name, code: it.code, groupId: it.groupId, doc: doc++, qtty, amount: qtty * price });
  }
  return lines;
}

const mockSource = {
  groups: async () => MOCK_GROUPS,
  salesByGroup: async (from, to) => daysBetween(from, to).flatMap((day) => mockLines(day).map((l) => ({ day, groupId: l.groupId, amount: l.amount }))),
  saleLines: async (date) => mockLines(date),
};
