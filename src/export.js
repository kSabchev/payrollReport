// Отчет за период в Excel: листове Обобщение, Приходи, Разходи и Разни (описанията)
const { parse, round2 } = require("./util");
const { data } = require("./data");
const { syncRange } = require("./microinvest");
const { storeParam, refreshFloat, buildReport } = require("./stores");
const { workbook } = require("./xlsx");

const WD = ["нд", "пн", "вт", "ср", "чт", "пт", "сб"];
const dayLabel = (s) => `${WD[parse(s).getDay()]} ${s.slice(8, 10)}.${s.slice(5, 7)}.${s.slice(0, 4)}`;
const money = (v, bold) => ({ v: round2(v || 0), money: true, bold });
const bold = (v) => ({ v, bold: true });
const expVal = (v) => (Array.isArray(v) ? v.reduce((a, i) => a + (i.value || 0), 0) : v || 0);

async function exportReport(from, to, storeId, user) {
  const sel = storeParam(storeId, true);
  let syncError = null;
  try { await syncRange(from, to, false, user); } catch (e) { syncError = e.message; }
  refreshFloat();
  const days = buildReport(from, to, sel);
  const storeName = sel === "all" ? "Всички магазини" : sel.name;
  const rev = data.revenueColumns, exp = data.expenseColumns;
  const revTotal = (d) => rev.reduce((s, c) => s + (d.revenue[c.id] || 0), 0);
  const expTotal = (d) => exp.reduce((s, c) => s + expVal(d.expenses[c.id]), 0);
  const sum = (f) => days.reduce((s, d) => s + f(d), 0);
  const lastBal = days.findLast((d) => d.balance != null)?.balance ?? null;

  const revenueSheet = {
    name: "Приходи", cols: [16, 14, ...rev.map(() => 14)],
    rows: [
      [bold("Дата"), bold("Общо"), ...rev.map((c) => bold(c.name))],
      ...days.map((d) => [dayLabel(d.date), money(revTotal(d)), ...rev.map((c) => money(d.revenue[c.id]))]),
      [bold("Общо"), money(sum(revTotal), true), ...rev.map((c) => money(sum((d) => d.revenue[c.id] || 0), true))],
    ],
  };
  const expenseSheet = {
    name: "Разходи", cols: [16, 14, 14, ...exp.map(() => 14)],
    rows: [
      [bold("Дата"), bold("Общо"), bold("Остатък"), ...exp.map((c) => bold(c.name))],
      ...days.map((d) => [dayLabel(d.date), money(expTotal(d)), d.balance == null ? null : money(d.balance),
        ...exp.map((c) => (d.expenses[c.id] == null ? null : money(expVal(d.expenses[c.id]))))]),
      [bold("Общо"), money(sum(expTotal), true), lastBal == null ? null : money(lastBal, true), ...exp.map((c) => money(sum((d) => expVal(d.expenses[c.id])), true))],
    ],
  };
  const revenue = sum(revTotal), expenses = sum(expTotal);
  const summary = {
    name: "Обобщение", cols: [28, 18],
    rows: [
      [bold("Отчет"), storeName],
      ["Период", `${from.split("-").reverse().join(".")} – ${to.split("-").reverse().join(".")}`],
      [],
      [bold("Приходи"), money(revenue, true)],
      [bold("Разходи"), money(expenses, true)],
      [bold("Приходи − разходи"), money(revenue - expenses, true)],
      ...(lastBal == null ? [] : [[bold("Оборотни − разходи (последен ден)"), money(lastBal, true)]]),
      [],
      [bold("Приходи по колони")],
      ...rev.map((c) => [c.name, money(sum((d) => d.revenue[c.id] || 0))]),
      [],
      [bold("Разходи по колони")],
      ...exp.map((c) => [c.name, money(sum((d) => expVal(d.expenses[c.id])))]),
      ...(syncError ? [[], ["Внимание", `Продажбите не са обновени от Microinvest: ${syncError}`]] : []),
    ],
  };
  const sheets = [summary, revenueSheet, expenseSheet];

  // Разходите със списъци (като „Разни“) — по ред за всеки запис, само за отделен магазин
  const lists = exp.filter((c) => c.kind === "list");
  if (sel !== "all" && lists.length) {
    const rows = [[bold("Дата"), bold("Колона"), bold("Описание"), bold("Сума")]];
    for (const d of days) for (const c of lists) for (const i of d.expenses[c.id] || []) rows.push([dayLabel(d.date), c.name, i.name || "", money(i.value)]);
    sheets.push({ name: lists.map((c) => c.name).join(", "), cols: [16, 16, 36, 14], rows });
  }

  const safe = (s) => s.replace(/[^\p{L}\p{N}_-]+/gu, "_");
  return { name: `Отчет_${safe(storeName)}_${from}_${to}.xlsx`, buffer: workbook(sheets) };
}

module.exports = { exportReport };
