// База на Microinvest Склад Про (SQL Server), само за четене: Operations, Goods, GoodsGroups, Objects.
// Продажбите се сумират в базата по ден, обект и група и се пазят в data.cache.
const { MOCK, RECENT_DAYS } = require("./config");
const { fmt, daysBetween, round2 } = require("./util");
const { data, saveData } = require("./data");
const { logHistory, who } = require("./history");

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

// ---------------------------------------------------------------- Състояние на връзката
// Връзката е „прекъсната“ само при грешки при свързване (вход, мрежа, таймаут) или липсваща
// настройка — не при грешка в отделна заявка (напр. липсващи права над една таблица).
const CONNECTION_ERRORS = new Set(["ELOGIN", "ESOCKET", "ETIMEOUT", "EINSTLOOKUP", "ECONNCLOSED", "ENOTOPEN", "EDRIVER", "ENOTCONFIGURED"]);
const db = { error: null, since: null, lastOk: data.dbLastOk || null };

function markOk() {
  const now = new Date().toISOString();
  if (db.error) logHistory({ kind: "sync", what: "connection", restored: true, text: "Връзката с базата е възстановена" });
  Object.assign(db, { error: null, since: null, lastOk: now });
  data.dbLastOk = now; // пази се при следващия запис на данните
}

function markDown(message) {
  if (!db.error) {
    db.since = new Date().toISOString();
    logHistory({ kind: "sync", what: "connection", error: message });
  }
  db.error = message;
}

function dbStatus() {
  if (MOCK) return { mock: true };
  return { configured: connectionInfo().configured, ok: !db.error, error: db.error, since: db.since, lastOk: db.lastOk };
}

let pool = null;
async function query(text, params = {}) {
  if (!connectionInfo().configured) {
    const msg = "Връзката с базата не е настроена. Попълнете MI_SQL_DATABASE, MI_SQL_USER и MI_SQL_PASSWORD в .env и рестартирайте програмата.";
    markDown(msg);
    throw new Error(msg);
  }
  try {
    pool ||= new sql.ConnectionPool(sqlConfig()).connect();
    const req = (await pool).request();
    for (const [k, [type, v]] of Object.entries(params)) req.input(k, type, v);
    const rows = (await req.query(text)).recordset;
    markOk();
    return rows;
  } catch (e) {
    console.error("SQL:", e.code || "", e.message);
    const p = pool; pool = null; (await p?.catch(() => null))?.close().catch(() => {});
    const msg = friendlySqlError(e);
    if (CONNECTION_ERRORS.has(e.code) || CONNECTION_ERRORS.has(e.originalError?.code)) markDown(msg);
    throw new Error(msg);
  }
}

// Проверка на връзката (SELECT 1), без запис в историята освен при промяна на състоянието
async function checkConnection() {
  if (MOCK) return dbStatus();
  try { await query("SELECT 1 AS ok"); } catch {}
  return dbStatus();
}

// При стартиране и после на всеки 5 минути, за да се знае „от кога“ няма връзка
function startConnectionChecks() {
  if (MOCK) return;
  setTimeout(checkConnection, 2000).unref();
  setInterval(checkConnection, 5 * 60 * 1000).unref();
}

// Датите се подават като параметри от тип date, без превръщане от текст в SQL.
// Драйверът праща Date в UTC, затова денят се създава в UTC и се чете обратно в UTC.
const toSqlDate = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const fromSqlDate = (d) => d.toISOString().slice(0, 10);

// Общи условия: вид операция, период (дати като "YYYY-MM-DD"), обекти (null = всички)
function salesFilter(from, to, objectIds = null) {
  const s = data.settings;
  const params = { from: [sql.Date, toSqlDate(from)], to: [sql.Date, toSqlDate(to)], vat: [sql.Bit, s.withVat] };
  const types = s.operationTypes.map((t, i) => { params["t" + i] = [sql.Int, t]; return "@t" + i; });
  let where = `o.OperType IN (${types.join(", ")})
    AND o.[Date] >= @from AND o.[Date] < DATEADD(day, 1, @to)`;
  if (objectIds) {
    const objs = objectIds.map((id, i) => { params["o" + i] = [sql.Int, id]; return "@o" + i; });
    where += ` AND o.ObjectID IN (${objs.join(", ") || "NULL"})`;
  }
  return { where, params };
}
// Реалната цена на продажбата (с корекциите от панела за продажба), с или без ДДС
const AMOUNT = "o.Qtty * (o.PriceOut + CASE WHEN @vat = 1 THEN o.VATOut ELSE 0 END)";

const sqlSource = {
  groups: () => query("SELECT ID AS id, Code AS code, Name AS name FROM GoodsGroups"),
  objects: () => query("SELECT ID AS id, Code AS code, Name AS name FROM Objects"),

  // [{ day, objectId, groupId, amount }] за всички обекти
  async salesByGroup(from, to) {
    const { where, params } = salesFilter(from, to);
    const rows = await query(`SELECT CAST(o.[Date] AS date) AS day, o.ObjectID AS objectId, g.GroupID AS groupId, SUM(${AMOUNT}) AS amount
      FROM Operations o LEFT JOIN Goods g ON g.ID = o.GoodID
      WHERE ${where}
      GROUP BY CAST(o.[Date] AS date), o.ObjectID, g.GroupID`, params);
    return rows.map((r) => ({ ...r, day: fromSqlDate(r.day) }));
  },

  // [{ goodId, name, code, groupId, doc, qtty, amount }] за един ден и дадени обекти (null = всички)
  saleLines(date, objectIds) {
    const { where, params } = salesFilter(date, date, objectIds);
    return query(`SELECT o.GoodID AS goodId, g.Name AS name, g.Code AS code, g.GroupID AS groupId, o.Acct AS doc,
        SUM(o.Qtty) AS qtty, SUM(${AMOUNT}) AS amount
      FROM Operations o LEFT JOIN Goods g ON g.ID = o.GoodID
      WHERE ${where}
      GROUP BY o.GoodID, g.Name, g.Code, g.GroupID, o.Acct`, params);
  },

  // Най-продаваните артикули за период: [{ goodId, name, code, groupId, qtty, amount }]
  topItems(from, to, objectIds, limit = 15) {
    const { where, params } = salesFilter(from, to, objectIds);
    params.top = [sql.Int, limit];
    return query(`SELECT TOP (@top) o.GoodID AS goodId, g.Name AS name, g.Code AS code, g.GroupID AS groupId,
        SUM(o.Qtty) AS qtty, SUM(${AMOUNT}) AS amount
      FROM Operations o LEFT JOIN Goods g ON g.ID = o.GoodID
      WHERE ${where}
      GROUP BY o.GoodID, g.Name, g.Code, g.GroupID
      ORDER BY SUM(${AMOUNT}) DESC`, params);
  },
};

// Източникът на данни: истинската база или демо продажбите (с един и същ интерфейс)
const source = MOCK ? require("./mock").mockSource : sqlSource;

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

// Основните групи по код; подгрупите (AER…, AES…) ги наследяват
const DEFAULT_GROUP_CODES = { AES: "service", AEU: "prima", AET: "phones", AER: "goods" };

// Групи артикули и обекти (кеширани 10 минути). Обектите не са задължителни:
// ако потребителят няма права над Objects, магазините се задават с номер на обекта.
// Обектът се променя на място, за да виждат промените и другите модули.
const catalog = { groups: [], objects: [], objectsError: null, loadedAt: 0 };

async function loadCatalog(force = false, user = null) {
  if (!force && Date.now() - catalog.loadedAt < 10 * 60 * 1000 && catalog.groups.length) return catalog;
  const trigger = force ? "manual" : "auto";
  const groups = await fromDb("groups", user, { trigger }, async () => {
    const g = await source.groups();
    return [g, { rows: g.length }];
  });
  let objects = [], objectsError = null;
  try {
    objects = await fromDb("objects", user, { trigger }, async () => {
      const o = await source.objects();
      return [o, { rows: o.length }];
    });
  } catch (e) { objectsError = e.message; }
  Object.assign(catalog, {
    groups: groups.map((g) => ({ id: g.id, code: String(g.code ?? "").trim(), name: g.name || `Група ${g.id}` }))
      .sort((a, b) => a.code.localeCompare(b.code)),
    objects: objects.map((o) => ({ id: o.id, code: String(o.code ?? "").trim(), name: o.name || `Обект ${o.id}` })).sort((a, b) => a.id - b.id),
    objectsError,
    loadedAt: Date.now(),
  });
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

// Колоните в Приходи, които получават продажби от Microinvest
function mappedColumns() {
  const set = new Set(Object.values(data.groupMap));
  set.add(data.settings.defaultRevenueColumn);
  return [...set];
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
    const r = await source.salesByGroup(a, b);
    return [r, { rows: r.length, amount: round2(r.reduce((s, x) => s + Number(x.amount || 0), 0)) }];
  });
  const fresh = Object.fromEntries(need.map((d) => [d, { byObject: {}, fetchedAt: Date.now() }]));
  for (const r of rows) {
    if (!fresh[r.day]) continue;
    const byGroup = (fresh[r.day].byObject[String(r.objectId ?? "none")] ||= {});
    const gid = String(r.groupId ?? "none");
    byGroup[gid] = round2((byGroup[gid] || 0) + Number(r.amount || 0));
  }
  Object.assign(data.cache, fresh);
  saveData();
}

module.exports = {
  connectionInfo, dbStatus, checkConnection, startConnectionChecks,
  source, fromDb, catalog, loadCatalog, columnForGroup, mappedColumns, syncRange,
};
