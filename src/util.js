// Дати, числа и текст за историята

// ---------------------------------------------------------------- Дати ("YYYY-MM-DD", местно време)
const pad = (n) => String(n).padStart(2, "0");
const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const monthStart = (s) => s.slice(0, 8) + "01";

function daysBetween(from, to) {
  const out = [];
  for (let d = parse(from); fmt(d) <= to; d.setDate(d.getDate() + 1)) out.push(fmt(d));
  return out;
}

// ---------------------------------------------------------------- Числа
const round2 = (n) => Math.round(n * 100) / 100;

// Число от въведен текст ("1 234,5"); празно = null, невалидно = грешка
const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(/\s/g, "").replace(",", "."));
  if (!Number.isFinite(n)) throw new Error("Невалидно число: " + v);
  return round2(n);
};

// Нов уникален id (за колони и магазини)
function slug(name, existing) {
  let base = "c" + Date.now().toString(36);
  while (existing.some((c) => c.id === base)) base += "x";
  return base;
}

// ---------------------------------------------------------------- Текст за историята
const moneyFmt = new Intl.NumberFormat("bg-BG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dmy = (s) => `${s.slice(8, 10)}.${s.slice(5, 7)}.${s.slice(0, 4)}`;
const showVal = (v) => v == null ? "—"
  : Array.isArray(v) ? `${moneyFmt.format(v.reduce((a, i) => a + (i.value || 0), 0))} (${v.length} бр.)` : moneyFmt.format(v);
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

module.exports = { pad, fmt, parse, isDate, monthStart, daysBetween, round2, num, slug, dmy, showVal, same };
