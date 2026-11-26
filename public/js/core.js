// Помощни функции, състояние на страницата и изчисления

// ------------------------------------------------------------ Помощни
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const money = new Intl.NumberFormat("bg-BG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qfmt = new Intl.NumberFormat("bg-BG", { maximumFractionDigits: 3 });
const m = (n) => money.format(n || 0);
const mOrBlank = (n) => (n ? money.format(n) : "");
const pad = (n) => String(n).padStart(2, "0");
const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = (s) => { const [y, mo, d] = s.split("-").map(Number); return new Date(y, mo - 1, d); };
const MONTHS = ["януари", "февруари", "март", "април", "май", "юни", "юли", "август", "септември", "октомври", "ноември", "декември"];
const WD = ["нд", "пн", "вт", "ср", "чт", "пт", "сб"];
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const toNum = (v) => { const s = String(v ?? "").trim().replace(/\s/g, "").replace(",", "."); if (!s) return null; const n = Number(s); return Number.isFinite(n) ? n : NaN; };

// Относителен адрес, за да работи и под подпът (напр. https://сървър/payroll/).
async function api(path, body) {
  const r = await fetch(path.replace(/^\//, ""), body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
  const j = await r.json().catch(() => ({ error: "Невалиден отговор от сървъра" }));
  if (r.status === 401 && j.login) showAuth(false); // сесията е изтекла
  if (!r.ok) throw new Error(j.error || "Грешка");
  return j;
}

// ------------------------------------------------------------ Състояние
const S = {
  mode: "month", anchor: fmt(new Date()), from: null, to: null, group: "month", tab: "expense",
  meta: null, days: [], syncError: null, loading: false, loadedAt: null, histKind: "", groupsOpen: false, store: localStorage.getItem("store") || "",
};
const today = () => fmt(new Date());

// Магазин: id или "all" (сбор, само за четене)
const readOnly = () => S.store === "all";
const storeName = (id) => S.meta.stores.find((x) => x.id === id)?.name ?? "";
const multiStore = () => S.meta.stores.length > 1;
function fixStore() {
  const ok = (S.store === "all" && multiStore()) || S.meta.stores.some((x) => x.id === S.store);
  if (!ok) S.store = S.meta.stores[0].id;
  localStorage.setItem("store", S.store);
}
const curFloat = () => (readOnly() ? null : S.meta.floats[S.store]);

const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return fmt(d); };
const spanDays = (from, to) => Math.round((parse(to) - parse(from)) / 864e5) + 1;
const short = (s, withYear) => { const d = parse(s); return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}${withYear ? "." + d.getFullYear() : ""}`; };

function period() {
  if (S.mode === "range") {
    const label = S.from === S.to ? short(S.from, true) : `${short(S.from, S.from.slice(0, 4) !== S.to.slice(0, 4))} – ${short(S.to, true)}`;
    return { from: S.from, to: S.to, label };
  }
  const a = parse(S.anchor), y = a.getFullYear(), mo = a.getMonth();
  if (S.mode === "day") return { from: S.anchor, to: S.anchor, label: `${WD[a.getDay()]}, ${a.getDate()} ${MONTHS[mo]} ${y}` };
  if (S.mode === "month") return { from: fmt(new Date(y, mo, 1)), to: fmt(new Date(y, mo + 1, 0)), label: `${cap(MONTHS[mo])} ${y}` };
  if (S.mode === "quarter") { const q = Math.floor(mo / 3); return { from: fmt(new Date(y, q * 3, 1)), to: fmt(new Date(y, q * 3 + 3, 0)), label: `${q + 1}-во тримесечие ${y}`.replace("2-во", "2-ро").replace("3-во", "3-то").replace("4-во", "4-то") }; }
  return { from: `${y}-01-01`, to: `${y}-12-31`, label: `${y} г.` };
}

function shift(dir) {
  if (S.mode === "range") {
    const n = spanDays(S.from, S.to) * dir;
    S.from = addDays(S.from, n); S.to = addDays(S.to, n);
    return load();
  }
  const a = parse(S.anchor);
  if (S.mode === "day") a.setDate(a.getDate() + dir);
  else { a.setDate(1); a.setMonth(a.getMonth() + dir * (S.mode === "month" ? 1 : S.mode === "quarter" ? 3 : 12)); }
  S.anchor = fmt(a);
  load();
}

const canGroup = () => S.mode === "quarter" || S.mode === "year" || (S.mode === "range" && spanDays(S.from, S.to) > 31);
const byGroupRows = () => canGroup() && S.group === "month";

// ------------------------------------------------------------ Изчисления
const revCols = () => S.meta.revenueColumns;
const expCols = () => S.meta.expenseColumns;
const expVal = (day, col) => { const v = day.expenses[col.id]; return Array.isArray(v) ? v.reduce((s, i) => s + (i.value || 0), 0) : (v || 0); };
const revTotal = (day) => revCols().reduce((s, c) => s + (day.revenue[c.id] || 0), 0);
const expTotal = (day) => expCols().reduce((s, c) => s + expVal(day, c), 0);

// Редове: дни или месеци (сборно)
function rows() {
  if (!byGroupRows()) return S.days.map((d) => ({ key: d.date, day: d, days: [d] }));
  const map = new Map();
  for (const d of S.days) {
    const k = d.date.slice(0, 7);
    if (!map.has(k)) map.set(k, { key: k, days: [] });
    map.get(k).days.push(d);
  }
  return [...map.values()];
}
const sum = (days, f) => days.reduce((s, d) => s + f(d), 0);
