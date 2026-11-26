// Статистика за период: суми и сравнения, приходи по колони във времето, печалба,
// средно по дни от седмицата, най-продавани артикули, сравнение на магазините.
const { fmt, parse, daysBetween, round2 } = require("./util");
const { data } = require("./data");
const { source, fromDb, loadCatalog, columnForGroup, syncRange } = require("./microinvest");
const { storeParam, objectIdsOf, refreshFloat, buildReport } = require("./stores");

const lastDay = (y, m) => new Date(y, m + 1, 0).getDate(); // m: 0..11

// Дата + n месеца, денят се ограничава до края на месеца (31.03 − 1 месец = 28/29.02)
function addMonths(s, n) {
  const d = parse(s), y = d.getFullYear(), m = d.getMonth() + n;
  const t = new Date(y, m, 1);
  return fmt(new Date(t.getFullYear(), t.getMonth(), Math.min(d.getDate(), lastDay(t.getFullYear(), t.getMonth()))));
}
const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return fmt(d); };
// Като addMonths, но последният ден на месец остава последен (30.06 − 3 месеца = 31.03)
function shiftEnd(s, n) {
  const d = parse(s);
  if (d.getDate() !== lastDay(d.getFullYear(), d.getMonth())) return addMonths(s, n);
  const t = new Date(d.getFullYear(), d.getMonth() + n + 1, 0);
  return fmt(t);
}

// Периодът е цели календарни месеци (от 1-во до последния ден)
function wholeMonths(from, to) {
  const t = parse(to);
  if (!from.endsWith("-01") || t.getDate() !== lastDay(t.getFullYear(), t.getMonth())) return 0;
  const f = parse(from);
  return (t.getFullYear() - f.getFullYear()) * 12 + t.getMonth() - f.getMonth() + 1;
}

// Сравними периоди. Текущият се реже до днес, а сравненията са със същия брой дни:
// при цели месеци — същите дни от предишния месец (или N месеца) и от миналата година.
function comparePeriods(from, to) {
  const today = fmt(new Date());
  const effTo = to > today ? (from > today ? from : today) : to;
  const months = wholeMonths(from, to);
  const prev = months
    ? { from: addMonths(from, -months), to: shiftEnd(effTo, -months) }
    : { from: addDays(from, -daysBetween(from, to).length), to: addDays(effTo, -daysBetween(from, to).length) };
  const lastYear = { from: addMonths(from, -12), to: shiftEnd(effTo, -12) };
  return { current: { from, to: effTo }, prev, lastYear };
}

const expVal = (v) => (Array.isArray(v) ? v.reduce((a, i) => a + (i.value || 0), 0) : v || 0);
const revSum = (d) => Object.values(d.revenue).reduce((a, b) => a + (b || 0), 0);
const expSum = (d) => data.expenseColumns.reduce((s, c) => s + expVal(d.expenses[c.id]), 0);

function totals(days) {
  const byColumn = Object.fromEntries(data.revenueColumns.map((c) => [c.id, 0]));
  let revenue = 0, expenses = 0;
  for (const d of days) {
    for (const c of data.revenueColumns) byColumn[c.id] += d.revenue[c.id] || 0;
    revenue += revSum(d); expenses += expSum(d);
  }
  for (const k in byColumn) byColumn[k] = round2(byColumn[k]);
  return { revenue: round2(revenue), expenses: round2(expenses), profit: round2(revenue - expenses), byColumn };
}

async function computeStats(from, to, storeId, user) {
  const sel = storeParam(storeId, true);
  const periods = comparePeriods(from, to);
  let syncError = null;
  for (const p of [{ from, to }, periods.prev, periods.lastYear]) {
    try { await syncRange(p.from, p.to, false, user); } catch (e) { syncError ||= e.message; }
  }
  refreshFloat();

  const today = fmt(new Date());
  const days = buildReport(from, to, sel);
  const past = days.filter((d) => d.date <= today);

  // По дни до 62 дни, иначе по месеци
  const byDay = daysBetween(from, to).length <= 62;
  const buckets = new Map();
  for (const d of days) {
    const key = byDay ? d.date : d.date.slice(0, 7);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(d);
  }
  const series = [...buckets].map(([key, ds]) => ({ key, future: ds.every((d) => d.date > today), ...totals(ds) }));

  // Средно на ден по дни от седмицата (само минали дни, за които има данни)
  const wd = Array.from({ length: 7 }, (_, i) => ({ weekday: i, days: 0, revenue: 0 }));
  for (const d of past.filter((x) => x.loaded)) {
    const w = wd[parse(d.date).getDay()];
    w.days++; w.revenue += revSum(d);
  }
  const weekdays = [1, 2, 3, 4, 5, 6, 0].map((i) => ({ ...wd[i], revenue: round2(wd[i].revenue), avg: wd[i].days ? round2(wd[i].revenue / wd[i].days) : 0 }));

  // Най-продавани артикули (само до днес)
  let topItems = [], topError = null;
  const topTo = periods.current.to;
  if (from <= today) {
    try {
      await loadCatalog(false, user);
      const rows = await fromDb("top", user, { trigger: "auto", from, to: topTo }, async () => {
        const r = await source.topItems(from, topTo, objectIdsOf(sel));
        return [r, { rows: r.length }];
      });
      topItems = rows.map((r) => ({ name: r.name ?? `Артикул ${r.goodId}`, code: r.code ?? "", qtty: round2(Number(r.qtty || 0)),
        amount: round2(Number(r.amount || 0)), col: columnForGroup(String(r.groupId ?? "none")) }));
    } catch (e) { topError = e.message; }
  }

  // Магазините един до друг (когато са няколко)
  const stores = data.stores.length > 1
    ? data.stores.map((st) => ({ id: st.id, name: st.name, ...totals(buildReport(from, to, st).filter((d) => d.date <= today)) }))
    : [];

  return {
    from, to, byDay, syncError,
    current: { ...periods.current, ...totals(past) },
    prev: { ...periods.prev, ...totals(buildReport(periods.prev.from, periods.prev.to, sel)) },
    lastYear: { ...periods.lastYear, ...totals(buildReport(periods.lastYear.from, periods.lastYear.to, sel)) },
    series, weekdays, topItems, topError, stores,
  };
}

module.exports = { computeStats, comparePeriods, addMonths };
