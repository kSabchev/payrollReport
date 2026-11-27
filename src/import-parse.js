// Четене на разходите от Excel файл, без запис (вижте import.js за вида на файла)
const { pad, round2, dmy, showVal } = require("./util");
const { readWorkbook, colIndex } = require("./xlsx-read");

const MONTH_NAMES = [
  ["януари", "january", "jan"], ["февруари", "february", "feb"], ["март", "march", "mar"], ["април", "april", "apr"],
  ["май", "may"], ["юни", "june", "jun"], ["юли", "july", "jul"], ["август", "august", "aug"],
  ["септември", "september", "sep"], ["октомври", "october", "oct"], ["ноември", "november", "nov"], ["декември", "december", "dec"],
];
const norm = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

// Месец (1–12) от името на листа: „Януари“, „яну“, „01“, „1“, „Януари 2026“
function monthOf(name) {
  const n = norm(name).replace(/\d{4}/, "");
  if (/^\d{1,2}$/.test(n) && +n >= 1 && +n <= 12) return +n;
  for (let i = 0; i < 12; i++) {
    if (MONTH_NAMES[i].some((w) => n === w || (n.length >= 3 && w.startsWith(n)) || n.startsWith(w))) return i + 1;
  }
  return null;
}

const isText = (v) => typeof v === "string" && v.trim() !== "";
const toNumber = (v) => {
  if (typeof v === "number") return v;
  if (typeof v !== "string") return null;
  const s = v.trim().replace(/\s/g, "").replace(",", ".");
  return s && Number.isFinite(Number(s)) ? Number(s) : null;
};
const daysIn = (y, m) => new Date(y, m, 0).getDate();
const excelDate = (n) => { const d = new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 864e5); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };
const TOTAL_ROW = /^(sum|total|общо|сума|всичко)/i;

// Чете файла и връща разходите по дни, без да записва нищо
function parseExpenses(buffer, year) {
  const sheets = readWorkbook(buffer);
  const months = [], skipped = [], warnings = [], errors = [];
  const headers = [];        // заглавията на колоните за внасяне, по реда в първия лист
  const byDate = new Map();  // дата -> { заглавие: сума }
  for (const sh of sheets) {
    const month = monthOf(sh.name);
    // Ред със заглавия: първият с поне две текстови клетки
    const headRow = [...sh.rows.keys()].sort((a, b) => a - b).find((r) => Object.values(sh.rows.get(r)).filter(isText).length >= 2);
    if (!headRow) { skipped.push(`${sh.name} (няма заглавия)`); continue; }
    const head = sh.rows.get(headRow);
    const cols = Object.keys(head).filter((c) => isText(head[c])).sort((a, b) => colIndex(a) - colIndex(b));
    const totalCol = cols.find((c) => /разход/i.test(head[c]));
    const dateCol = cols.find((c) => /^(дата|ден|date|day)$/i.test(norm(head[c])));
    let use = totalCol ? cols.filter((c) => colIndex(c) > colIndex(totalCol)) : cols.filter((c) => c !== dateCol);
    const stop = use.find((c) => /^приход/i.test(head[c]));
    if (stop) use = use.filter((c) => colIndex(c) < colIndex(stop));
    if (!use.length) { skipped.push(`${sh.name} (няма колони с разходи)`); continue; }
    for (const c of use) if (!headers.includes(head[c].trim())) headers.push(head[c].trim());

    let count = 0, total = 0, usedSheet = false;
    for (const r of [...sh.rows.keys()].filter((r) => r > headRow).sort((a, b) => a - b)) {
      const row = sh.rows.get(r);
      const first = row[dateCol || "A"];
      if (isText(first) && TOTAL_ROW.test(first.trim())) break;
      // Дата: от колоната с дата (ден 1–31, дата в Excel или текст ДД.ММ.ГГГГ), иначе поредният ред
      let date = null, n = toNumber(first);
      if (n != null && n > 31) date = excelDate(n);
      else if (isText(first) && /^\d{1,2}[./-]\d{1,2}[./-]\d{4}$/.test(first.trim())) {
        const [d, mo, y] = first.trim().split(/[./-]/).map(Number);
        date = `${y}-${pad(mo)}-${pad(d)}`;
      } else {
        if (!month) continue;
        const byRow = !(n != null && Number.isInteger(n) && n >= 1);
        const day = byRow ? r - headRow : n;
        if (byRow && day > 31) break; // ред със суми без надпис
        if (day > daysIn(year, month)) {
          if (use.some((c) => toNumber(row[c]))) errors.push(`Лист „${sh.name}“, ред ${r}: в ${MONTH_NAMES[month - 1][0]} няма ${day}-во число`);
          continue;
        }
        date = `${year}-${pad(month)}-${pad(day)}`;
      }
      const values = {};
      for (const c of use) {
        const v = row[c];
        if (v == null) continue;
        const x = toNumber(v);
        if (x == null) { if (isText(v)) warnings.push(`Лист „${sh.name}“, ${c}${r}: „${v}“ не е число и е пропуснато`); continue; }
        if (round2(x)) values[head[c].trim()] = round2((values[head[c].trim()] || 0) + x);
      }
      if (totalCol && toNumber(row[totalCol]) != null) {
        const s = round2(Object.values(values).reduce((a, b) => a + b, 0));
        if (Math.abs(s - toNumber(row[totalCol])) > 0.01) warnings.push(`Лист „${sh.name}“, ред ${r}: сборът на колоните (${showVal(s)}) не е равен на „${head[totalCol]}“ (${showVal(toNumber(row[totalCol]))})`);
      }
      if (!Object.keys(values).length) continue;
      if (byDate.has(date)) { errors.push(`${dmy(date)} се среща повече от веднъж (лист „${sh.name}“)`); continue; }
      byDate.set(date, values);
      usedSheet = true; count++; total += Object.values(values).reduce((a, b) => a + b, 0);
    }
    if (usedSheet) months.push({ sheet: sh.name, days: count, total: round2(total) });
    else skipped.push(`${sh.name} (${month || dateCol ? "няма разходи" : "името не е месец"})`);
  }
  const days = [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, values]) => ({ date, values }));
  return { months, skipped, warnings, errors, headers, days };
}

module.exports = { parseExpenses, monthOf, norm };
