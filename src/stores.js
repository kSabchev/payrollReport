// Магазини, оборотни пари и отчетът по дни.
//
// Оборотни пари: всеки месец се нулират (от 1-во число). Админът се пита на 1-во,
// или на 2-ро, ако 1-во е неделя. Докато не потвърди, остатъкът продължава от предишния месец.
const { fmt, parse, monthStart, daysBetween, round2 } = require("./util");
const { data, saveData } = require("./data");
const { columnForGroup } = require("./microinvest");

const sd = (st) => data.byStore[st.id];

// Магазин по id; без id — първият. "all" се приема само където allowAll.
function storeParam(id, allowAll = false) {
  if (id === "all" && allowAll) return data.stores.length > 1 ? "all" : data.stores[0];
  if (id === undefined || id === null || id === "") return data.stores[0];
  const st = data.stores.find((x) => x.id === id);
  if (!st) throw new Error("Няма такъв магазин");
  return st;
}

// Обектите в Microinvest за избора (null = всички обекти)
const objectIdsOf = (sel) => {
  const list = sel === "all" ? data.stores : [sel];
  return list.some((st) => st.objectId == null) ? null : list.map((st) => st.objectId);
};

// Префикс за историята, само когато има няколко магазина
const storeLabel = (st) => (data.stores.length > 1 ? `${st.name} · ` : "");

function storesView() {
  return data.stores.map((st) => ({ ...st, hasData: Object.keys(sd(st).expenses).length > 0 || Object.keys(sd(st).revenueManual).length > 0 }));
}

// ---------------------------------------------------------------- Оборотни пари
function resetPromptDay(month) {
  const d = parse(month + "-01");
  if (d.getDay() === 0) d.setDate(2);
  return fmt(d);
}

function expenseTotal(st, date) {
  const day = sd(st).expenses[date];
  if (!day) return 0;
  let s = 0;
  for (const c of data.expenseColumns) {
    const v = day[c.id];
    s += Array.isArray(v) ? v.reduce((a, i) => a + (i.value || 0), 0) : v || 0;
  }
  return s;
}

function ensureFloat(st) {
  const f = sd(st).float;
  if (f.length) return false;
  f.push({ date: monthStart(fmt(new Date())), amount: st.floatDefault, at: Date.now() });
  return true;
}

// Преизчислява остатъка за всеки ден от първото нулиране до днес. Връща true при промяна.
function recomputeFloat(st) {
  const { float } = sd(st), out = {};
  if (float.length) {
    let i = 0, bal = 0;
    for (const d of daysBetween(float[0].date, fmt(new Date()))) {
      while (i < float.length && float[i].date === d) bal = float[i++].amount;
      bal = round2(bal - expenseTotal(st, d));
      out[d] = bal;
    }
  }
  if (JSON.stringify(out) === JSON.stringify(sd(st).floatBalance)) return false;
  sd(st).floatBalance = out;
  return true;
}

function refreshFloat() {
  let changed = false;
  for (const st of data.stores) changed = (ensureFloat(st) | recomputeFloat(st)) || changed;
  if (changed) saveData();
}

function activeReset(st) {
  const today = fmt(new Date());
  return sd(st).float.findLast((r) => r.date <= today) || null;
}

function floatStatus(st) {
  const today = fmt(new Date()), month = today.slice(0, 7), { float, floatBalance } = sd(st);
  const due = today >= resetPromptDay(month) && !float.some((r) => r.date.startsWith(month));
  return {
    store: st.id, name: st.name,
    resets: float.map(({ date, amount }) => ({ date, amount })),
    current: activeReset(st),
    balance: floatBalance[today] ?? null,
    default: st.floatDefault,
    pendingReset: due ? { date: month + "-01" } : null,
  };
}

const floatsAll = () => Object.fromEntries(data.stores.map((st) => [st.id, floatStatus(st)]));

const balancesFor = (st, from, to) => Object.fromEntries(daysBetween(from, to).map((d) => [d, sd(st).floatBalance[d] ?? null]));

// ---------------------------------------------------------------- Отчет по дни
// Продажби от кеша за магазина, по колони
function storeRevenueApi(st, cached) {
  const api = {};
  for (const c of data.revenueColumns) api[c.id] = 0;
  if (cached?.byObject) {
    const objs = st.objectId == null ? Object.keys(cached.byObject) : [String(st.objectId)];
    for (const o of objs) {
      for (const [gid, amount] of Object.entries(cached.byObject[o] || {})) {
        const col = columnForGroup(gid);
        if (col in api) api[col] += amount;
      }
    }
  }
  for (const k in api) api[k] = round2(api[k]);
  return api;
}

function storeDays(st, from, to) {
  const { revenueManual, expenses, floatBalance } = sd(st);
  return daysBetween(from, to).map((date) => {
    const cached = data.cache[date];
    const api = storeRevenueApi(st, cached);
    const manual = revenueManual[date] || {};
    const revenue = {};
    for (const c of data.revenueColumns) revenue[c.id] = manual[c.id] ?? api[c.id];
    return { date, revenue, revenueApi: api, edited: Object.keys(manual), loaded: !!cached, expenses: expenses[date] || {},
      balance: floatBalance[date] ?? null };
  });
}

// "all" — сбор от всички магазини; само за четене (разходите от списъци стават суми)
function buildReport(from, to, sel) {
  if (sel !== "all") return storeDays(sel, from, to);
  const per = data.stores.map((st) => storeDays(st, from, to));
  const add = (a, b) => round2((a || 0) + (b || 0));
  const expVal = (v) => (Array.isArray(v) ? v.reduce((a, i) => a + (i.value || 0), 0) : v);
  return per[0].map((first, i) => {
    const days = per.map((p) => p[i]);
    const out = { date: first.date, revenue: {}, revenueApi: {}, edited: [], loaded: days.every((d) => d.loaded), expenses: {}, balance: null, readonly: true };
    for (const c of data.revenueColumns) {
      out.revenue[c.id] = days.reduce((s, d) => add(s, d.revenue[c.id]), 0);
      out.revenueApi[c.id] = days.reduce((s, d) => add(s, d.revenueApi[c.id]), 0);
    }
    for (const c of data.expenseColumns) {
      const vals = days.map((d) => expVal(d.expenses[c.id])).filter((v) => v != null);
      if (vals.length) out.expenses[c.id] = vals.reduce(add, 0);
    }
    const bals = days.map((d) => d.balance).filter((b) => b != null);
    if (bals.length) out.balance = bals.reduce(add, 0);
    return out;
  });
}

module.exports = {
  sd, storeParam, objectIdsOf, storeLabel, storesView,
  ensureFloat, recomputeFloat, refreshFloat, activeReset, floatsAll, balancesFor, buildReport,
};
