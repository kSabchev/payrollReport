// Отчет приходи / разходи / оборот с данни от Microinvest Склад Про
// Node.js 18+, без външни пакети.  Старт: node server.js   Демо: MOCK=1 node server.js

const http = require("http");
const fs = require("fs");
const path = require("path");

const MOCK = process.env.MOCK === "1";
const PORT = Number(process.env.PORT || 3000);
const DATA_FILE = path.join(__dirname, MOCK ? "data-demo.json" : "data.json");
const RECENT_DAYS = 3; // последните N дни винаги се презареждат от Microinvest

// ---------------------------------------------------------------- Данни
const DEFAULT_DATA = {
  settings: {
    apiBase: process.env.MI_URL || "http://127.0.0.1:8700",
    apiKey: process.env.MI_KEY || "",
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
  groupMap: {},        // id на група в Microinvest -> id на колона в Приходи
  expenses: {},        // "YYYY-MM-DD" -> { колона: число | [{name, value}] }
  revenueManual: {},   // "YYYY-MM-DD" -> { колона: число }  (ръчни стойности и корекции)
  cache: {},           // "YYYY-MM-DD" -> { byGroup: { групаId: сума }, fetchedAt }
  float: [],           // нулирания на оборотните пари, по дата: [{ date, amount, at }]
  floatBalance: {},    // "YYYY-MM-DD" -> оборотни − разходи в края на деня
};

let data = loadData();

function loadData() {
  try {
    const d = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    return { ...structuredClone(DEFAULT_DATA), ...d, settings: { ...DEFAULT_DATA.settings, ...d.settings } };
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

// ---------------------------------------------------------------- Microinvest API
async function miGet(p, params = {}) {
  if (MOCK) return mockGet(p, params);
  const s = data.settings;
  const url = new URL(s.apiBase.replace(/\/$/, "") + p);
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== "") url.searchParams.set(k, v);
  const headers = { Accept: "application/json" };
  if (s.apiKey) headers["X-API-Key"] = s.apiKey;
  let res;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
  } catch (e) {
    throw new Error(`Няма връзка с Microinvest на ${s.apiBase}. Проверете дали Utility Center работи с включен модул Microinvest API и отворен порт 8700.`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Microinvest ${p} върна HTTP ${res.status}${body ? ": " + body.slice(0, 200) : ""}`);
  }
  const json = await res.json();
  return { rows: Array.isArray(json) ? json : json?.data ?? [], totalPages: Number(res.headers.get("X-TotalPages")) || 1 };
}

async function miGetAll(p, params = {}) {
  const rows = [];
  for (let page = 1, total = 1; page <= total; page++) {
    const r = await miGet(p, { ...params, page, page_size: 500 });
    rows.push(...r.rows);
    total = r.totalPages;
  }
  return rows;
}

// Номенклатура: артикули и групи (кеширани 10 минути)
let catalog = { items: new Map(), groups: [], loadedAt: 0 };
async function loadCatalog(force = false) {
  if (!force && Date.now() - catalog.loadedAt < 10 * 60 * 1000 && catalog.items.size) return catalog;
  const [items, groups] = await Promise.all([miGetAll("/Items"), miGetAll("/ItemsGroups")]);
  catalog = {
    items: new Map(items.map((i) => [String(i.id), { name: i.name, code: i.code, groupId: i.group_id }])),
    groups: groups.map((g) => ({ id: g.id, code: g.code ?? "", name: g.name ?? g.Name ?? `Група ${g.id}` }))
      .sort((a, b) => String(a.code).localeCompare(String(b.code))),
    loadedAt: Date.now(),
  };
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

function lineAmount(op) {
  const price = Number(op.price_out || 0) + (data.settings.withVat ? Number(op.vat_out || 0) : 0);
  return Number(op.qtty || 0) * price;
}

async function fetchOperations(from, to) {
  const s = data.settings;
  const all = [];
  for (const type of s.operationTypes) {
    const rows = await miGetAll("/Operations", { operation_type: type, object_id: s.objectId, date_from: from, date_to: to });
    all.push(...rows.filter((r) => r.operation_type == null || Number(r.operation_type) === Number(type)));
  }
  return all;
}

// Зарежда от Microinvest дните, които липсват в кеша или са скорошни
async function syncRange(from, to, force) {
  const today = fmt(new Date());
  const recent = new Date(); recent.setDate(recent.getDate() - RECENT_DAYS);
  const recentFrom = fmt(recent);
  const need = daysBetween(from, to).filter((d) => d <= today && (force || !data.cache[d] || d >= recentFrom));
  if (!need.length) return;

  await loadCatalog(force);
  const ops = await fetchOperations(need[0], need[need.length - 1]);
  const fresh = Object.fromEntries(need.map((d) => [d, { byGroup: {}, fetchedAt: Date.now() }]));
  for (const op of ops) {
    const d = String(op.date || "").slice(0, 10);
    if (!fresh[d]) continue;
    const gid = String(catalog.items.get(String(op.good_id))?.groupId ?? "none");
    fresh[d].byGroup[gid] = (fresh[d].byGroup[gid] || 0) + lineAmount(op);
  }
  Object.assign(data.cache, fresh);
  saveData();
}

const round2 = (n) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------- Оборотни пари
// Всеки месец оборотните пари се нулират (от 1-во число). Админът се пита на 1-во,
// или на 2-ро, ако 1-во е неделя. Докато не потвърди, остатъкът продължава от предишния месец.

// TODO: потребители и администратори; дотогава всички са админи
const isAdmin = () => true;

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

const handlers = {
  "GET /api/state": async () => {
    refreshFloat();
    let groups = catalog.groups, catalogError = null;
    try { groups = (await loadCatalog()).groups; } catch (e) { catalogError = e.message; }
    const { apiKey, ...settings } = data.settings;
    return { settings: { ...settings, hasApiKey: !!apiKey }, revenueColumns: data.revenueColumns, expenseColumns: data.expenseColumns,
      groupMap: data.groupMap, groups, mappedColumns: mappedColumns(), catalogError, mock: MOCK,
      isAdmin: isAdmin(), float: floatStatus() };
  },

  "GET /api/report": async (q) => {
    const from = q.get("from"), to = q.get("to");
    if (!isDate(from) || !isDate(to) || from > to) throw new Error("Невалиден период");
    let syncError = null;
    try { await syncRange(from, to, q.get("force") === "1"); } catch (e) { syncError = e.message; }
    refreshFloat();
    return { days: buildReport(from, to), syncError, mappedColumns: mappedColumns(), float: floatStatus() };
  },

  // Продажбите от Microinvest за един ден и една колона — за проверка
  "GET /api/detail": async (q) => {
    const date = q.get("date"), col = q.get("col");
    if (!isDate(date)) throw new Error("Невалидна дата");
    await loadCatalog();
    const ops = await fetchOperations(date, date);
    const byItem = new Map();
    for (const op of ops) {
      if (String(op.date || "").slice(0, 10) !== date) continue;
      const item = catalog.items.get(String(op.good_id));
      if (columnForGroup(String(item?.groupId ?? "none")) !== col) continue;
      const key = String(op.good_id);
      const row = byItem.get(key) || { name: item?.name ?? `Артикул ${key}`, code: item?.code ?? "", qtty: 0, amount: 0, docs: new Set() };
      row.qtty += Number(op.qtty || 0);
      row.amount += lineAmount(op);
      if (op.document_number) row.docs.add(op.document_number);
      byItem.set(key, row);
    }
    const lines = [...byItem.values()].map((r) => ({ ...r, qtty: round2(r.qtty), amount: round2(r.amount), docs: [...r.docs] }))
      .sort((a, b) => b.amount - a.amount);
    return { lines };
  },

  "POST /api/expense": async (_, b) => {
    if (!isDate(b.date) || !data.expenseColumns.some((c) => c.id === b.col)) throw new Error("Невалидни данни");
    const col = data.expenseColumns.find((c) => c.id === b.col);
    const day = (data.expenses[b.date] ||= {});
    if (col.kind === "list") {
      const items = (b.items || []).map((i) => ({ name: String(i.name || "").trim(), value: num(i.value) })).filter((i) => i.value !== null);
      if (items.length) day[b.col] = items; else delete day[b.col];
    } else {
      const v = num(b.value);
      if (v === null) delete day[b.col]; else day[b.col] = v;
    }
    if (!Object.keys(day).length) delete data.expenses[b.date];
    recomputeFloat();
    saveData();
    const balances = isDate(b.from) && isDate(b.to) && b.from <= b.to ? balancesFor(b.from, b.to) : {};
    return { ok: true, value: day[b.col] ?? null, balances, float: floatStatus() };
  },

  // action "set" — променя сумата на текущия месец; "reset" — нулира от 1-во число на месеца
  "POST /api/float": async (_, b) => {
    if (!isAdmin()) throw new Error("Само администратор може да променя оборотните пари");
    const amount = num(b.amount);
    if (amount === null || amount < 0) throw new Error("Въведете сума на оборотните пари");
    if (b.action === "set") {
      const r = activeReset();
      if (!r) throw new Error("Няма начална сума на оборотните пари");
      r.amount = amount;
    } else if (b.action === "reset") {
      const date = monthStart(fmt(new Date()));
      const r = data.float.find((x) => x.date === date);
      if (r) Object.assign(r, { amount, at: Date.now() });
      else data.float.push({ date, amount, at: Date.now() });
      data.float.sort((x, y) => x.date.localeCompare(y.date));
    } else throw new Error("Невалидно действие");
    data.settings.floatDefault = amount;
    recomputeFloat();
    saveData();
    return { ok: true, float: floatStatus() };
  },

  "POST /api/revenue": async (_, b) => {
    if (!isDate(b.date) || !data.revenueColumns.some((c) => c.id === b.col)) throw new Error("Невалидни данни");
    const day = (data.revenueManual[b.date] ||= {});
    const v = num(b.value);
    if (v === null) delete day[b.col]; else day[b.col] = v;
    if (!Object.keys(day).length) delete data.revenueManual[b.date];
    saveData();
    return { ok: true };
  },

  "POST /api/columns": async (_, b) => {
    const list = b.table === "revenue" ? data.revenueColumns : b.table === "expense" ? data.expenseColumns : null;
    if (!list) throw new Error("Невалидна таблица");
    const name = String(b.name || "").trim();
    if (b.action === "add") {
      if (!name) throw new Error("Въведете име на колоната");
      const col = { id: slug(name, list), name };
      if (b.table === "expense" && b.kind === "list") col.kind = "list";
      list.push(col);
    } else if (b.action === "rename") {
      const c = list.find((x) => x.id === b.id);
      if (!c || !name) throw new Error("Невалидни данни");
      c.name = name;
    } else if (b.action === "delete") {
      const i = list.findIndex((x) => x.id === b.id);
      if (i < 0) throw new Error("Няма такава колона");
      if (b.table === "revenue" && data.settings.defaultRevenueColumn === b.id) throw new Error("Това е колоната по подразбиране за продажбите. Изберете друга в Настройки, преди да я изтриете.");
      list.splice(i, 1);
      if (b.table === "revenue") for (const g in data.groupMap) if (data.groupMap[g] === b.id) delete data.groupMap[g];
    } else if (b.action === "move") {
      const i = list.findIndex((x) => x.id === b.id), j = i + (b.dir < 0 ? -1 : 1);
      if (i >= 0 && j >= 0 && j < list.length) [list[i], list[j]] = [list[j], list[i]];
    } else throw new Error("Невалидно действие");
    if (b.table === "expense") recomputeFloat();
    saveData();
    return { ok: true };
  },

  "POST /api/groupmap": async (_, b) => {
    if (b.col) data.groupMap[b.groupId] = b.col; else delete data.groupMap[b.groupId];
    saveData();
    return { ok: true };
  },

  "POST /api/settings": async (_, b) => {
    const s = data.settings;
    const connChanged = (b.apiBase !== undefined && b.apiBase !== s.apiBase) || b.apiKey !== undefined || b.objectId !== undefined;
    if (b.apiBase !== undefined) s.apiBase = String(b.apiBase).trim();
    if (b.apiKey !== undefined) s.apiKey = String(b.apiKey).trim();
    if (b.objectId !== undefined) s.objectId = b.objectId === "" || b.objectId === null ? null : Number(b.objectId);
    if (b.withVat !== undefined && b.withVat !== s.withVat) { s.withVat = !!b.withVat; data.cache = {}; }
    if (b.operationTypes !== undefined) {
      const t = String(b.operationTypes).split(/[ ,;]+/).map(Number).filter((n) => Number.isInteger(n) && n > 0);
      if (!t.length) throw new Error("Въведете поне един тип операция");
      if (t.join() !== s.operationTypes.join()) data.cache = {};
      s.operationTypes = t;
    }
    if (b.defaultRevenueColumn !== undefined) s.defaultRevenueColumn = b.defaultRevenueColumn;
    if (connChanged) { data.cache = {}; catalog.loadedAt = 0; }
    saveData();
    return { ok: true };
  },

  "POST /api/clear-cache": async () => {
    data.cache = {}; catalog.loadedAt = 0; saveData();
    return { ok: true };
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const h = handlers[`${req.method} ${url.pathname}`];
  if (h) {
    try {
      const body = req.method === "POST" ? await readBody(req) : null;
      send(res, 200, await h(url.searchParams, body));
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

server.listen(PORT, () => {
  console.log(`Отчет: http://localhost:${PORT}`);
  console.log(MOCK ? "Демо режим с примерни данни" : `Microinvest: ${data.settings.apiBase}`);
  console.log(`Данните се пазят в ${DATA_FILE}`);
});

// ---------------------------------------------------------------- Демо данни
function mockGet(p, params) {
  const groups = [
    { id: 1, code: "001", name: "Телефони" }, { id: 2, code: "002", name: "Аксесоари" },
    { id: 5, code: "002001", name: "Кабели и зарядни" }, { id: 3, code: "003", name: "Прима карти" },
    { id: 4, code: "004", name: "Сервизни услуги" },
  ];
  const items = [
    [1, "Samsung Galaxy A55", 1, 649], [2, "iPhone 15 128GB", 1, 1599], [3, "Redmi Note 13", 1, 389],
    [4, "Калъф силикон", 2, 15], [5, "Протектор стъкло", 2, 20], [6, "USB-C кабел 1м", 5, 12.9],
    [7, "Зарядно 20W", 5, 29], [8, "Прима карта 10", 3, 10], [9, "Прима карта 20", 3, 20],
    [10, "Смяна на дисплей", 4, 180], [11, "Смяна на батерия", 4, 70], [12, "Диагностика", 4, 15],
  ].map(([id, name, group_id, price]) => ({ id, code: String(100 + id), name, group_id, price }));

  if (p === "/ItemsGroups") return { rows: groups, totalPages: 1 };
  if (p === "/Items") return { rows: items, totalPages: 1 };
  if (p === "/Operations") {
    const rows = [];
    let doc = 1;
    for (const date of daysBetween(params.date_from, params.date_to)) {
      let seed = Number(date.replace(/-/g, ""));
      const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
      const n = parse(date).getDay() === 0 ? 3 : 8 + Math.floor(rnd() * 10);
      for (let i = 0; i < n; i++) {
        const it = items[Math.floor(rnd() * items.length)];
        if (it.group_id === 1 && rnd() > 0.3) continue;
        const gross = it.price;
        rows.push({ operation_type: 2, document_number: doc++, good_id: String(it.id), qtty: 1 + Math.floor(rnd() * (it.price < 30 ? 3 : 1)),
          price_out: round2(gross / 1.2), vat_out: round2(gross - gross / 1.2), date: date + "T00:00:00" });
      }
    }
    return { rows, totalPages: 1 };
  }
  return { rows: [], totalPages: 1 };
}
