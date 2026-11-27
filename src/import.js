// Импорт на разходи от Excel за минали месеци.
// Очакван вид: лист за всеки месец (име „Януари“, „Февруари“…), първият ред са заглавията,
// после ред за всеки ден (1, 2, … — в колона A или по реда). Редът „Sum“/„Общо“ се пропуска.
// Ако има заглавие „Разход … (общо)“, се внасят само колоните след него (преди тях са приходите),
// а общата сума се ползва за проверка. Всяка колона от файла се съпоставя с колона в Разходи.
const { fmt, round2, dmy, showVal, slug } = require("./util");
const { data, saveData } = require("./data");
const { audit } = require("./history");
const { backup, backupFailed, friendlyFsError } = require("./backup");
const { sd, storeParam, storeLabel, recomputeFloat, floatsAll } = require("./stores");
const { parseExpenses, norm } = require("./import-parse");

// Предложение за колона в Разходи по името на колоната от файла
const ALIASES = { онлине: "онлайн", online: "онлайн" };
function suggest(header) {
  const h = norm(header), a = ALIASES[h];
  const cols = data.expenseColumns.map((c) => ({ id: c.id, n: norm(c.name) }));
  return (cols.find((c) => c.n === h) || (a && cols.find((c) => c.n.startsWith(a)))
    || cols.find((c) => h.length >= 4 && (c.n.startsWith(h) || h.startsWith(c.n))))?.id || "";
}

// Годината: от заявката, от името на файла (напр. „Разходи2026.xlsx“) или текущата
function yearOf(b) {
  const y = Number(b.year) || Number(/(20\d\d)/.exec(b.fileName || "")?.[1]) || new Date().getFullYear();
  if (y < 2000 || y > 2100) throw new Error("Невалидна година");
  return y;
}

// Лев -> евро: официалният фиксиран курс. Еврото е в България от 01.01.2026, затова за по-стари
// години сумите по подразбиране се смятат за левове.
const BGN_PER_EUR = 1.95583;
const EURO_FROM_YEAR = 2026;

function load(b) {
  if (typeof b.file !== "string" || !b.file) throw new Error("Изберете Excel файл");
  const buf = Buffer.from(b.file, "base64");
  const year = yearOf(b);
  let parsed;
  try { parsed = parseExpenses(buf, year); }
  catch (e) { throw new Error("Файлът не може да се прочете: " + e.message); }
  // bgn: true/false от прозореца; без стойност — според годината
  const bgn = typeof b.bgn === "boolean" ? b.bgn : year < EURO_FROM_YEAR;
  if (bgn) {
    for (const d of parsed.days) for (const h in d.values) d.values[h] = round2(d.values[h] / BGN_PER_EUR);
    for (const m of parsed.months) m.total = round2(m.total / BGN_PER_EUR);
  }
  return { year, parsed, bgn };
}

const dayTotal = (values) => Object.values(values).reduce((a, b) => a + b, 0);

function preview(b) {
  const st = storeParam(b.store), { expenses } = sd(st);
  const { year, parsed, bgn } = load(b);
  const cols = parsed.headers.map((name) => {
    const vals = parsed.days.map((d) => d.values[name]).filter((v) => v != null);
    return { name, total: round2(vals.reduce((a, v) => a + v, 0)), count: vals.length, suggest: suggest(name) };
  });
  const existing = parsed.days.filter((d) => expenses[d.date]).map((d) => d.date);
  const today = fmt(new Date());
  return {
    store: st.id, year, bgn, rate: BGN_PER_EUR, months: parsed.months, skipped: parsed.skipped, warnings: parsed.warnings.slice(0, 50),
    warningCount: parsed.warnings.length, errors: parsed.errors, columns: cols,
    from: parsed.days[0]?.date ?? null, to: parsed.days.at(-1)?.date ?? null, days: parsed.days.length,
    total: round2(parsed.days.reduce((a, d) => a + dayTotal(d.values), 0)),
    existing, future: parsed.days.filter((d) => d.date > today).length,
  };
}

// mapping: { заглавие: id на колона | "new" (нова колона със същото име) | "" (не се внася) }
function apply(b, user) {
  const st = storeParam(b.store), { expenses } = sd(st);
  const { year, parsed, bgn } = load(b);
  if (parsed.errors.length) throw new Error("Файлът има грешки: " + parsed.errors[0]);
  if (!parsed.days.length) throw new Error("Във файла няма разходи за внасяне");
  const mapping = b.mapping || {};
  for (const h of parsed.headers) {
    const v = mapping[h];
    const used = parsed.days.some((d) => d.values[h] != null);
    if (v === undefined || v === null) { if (used) throw new Error(`Изберете колона за „${h}“`); continue; }
    if (v !== "" && v !== "new" && !data.expenseColumns.some((c) => c.id === v)) throw new Error(`Няма такава колона за „${h}“`);
  }

  let file;
  try { file = backup("before-import"); }
  catch (e) { backupFailed(e); throw new Error("Импортът е спрян, защото копието преди него не е направено: " + friendlyFsError(e)); }
  const target = {};
  const created = [];
  for (const h of parsed.headers) {
    if (mapping[h] === "new") {
      const col = { id: slug(h, data.expenseColumns), name: h };
      data.expenseColumns.push(col);
      created.push(h);
      target[h] = col;
    } else if (mapping[h]) target[h] = data.expenseColumns.find((c) => c.id === mapping[h]);
  }

  let imported = 0, skippedDays = 0, total = 0;
  const changed = [];
  for (const d of parsed.days) {
    const sums = {};
    for (const [h, v] of Object.entries(d.values)) if (target[h]) sums[target[h].id] = round2((sums[target[h].id] || 0) + v);
    if (!Object.keys(sums).length) continue;
    if (expenses[d.date] && !b.overwrite) { skippedDays++; continue; }
    const day = (expenses[d.date] ||= {});
    const before = structuredClone(day);
    for (const [id, v] of Object.entries(sums)) {
      const col = data.expenseColumns.find((c) => c.id === id);
      day[id] = col.kind === "list" ? [{ name: "от Excel", value: v }] : v;
      total += v;
    }
    imported++;
    changed.push({ date: d.date, before: Object.keys(before).length ? before : null, after: structuredClone(day) });
  }
  recomputeFloat(st);
  saveData();
  const range = imported ? `${dmy(changed[0].date)} – ${dmy(changed.at(-1).date)}` : "";
  audit(user, "import", `${storeLabel(st)}Импорт на разходи от Excel${b.fileName ? ` (${b.fileName})` : ""}: ${imported} дни${range ? `, ${range}` : ""}, общо ${showVal(round2(total))} €`
    + (bgn ? ` (от лева по курс ${String(BGN_PER_EUR).replace(".", ",")})` : "")
    + (skippedDays ? `; пропуснати ${skippedDays} дни с въведени разходи` : "")
    + (created.length ? `; нови колони: ${created.join(", ")}` : ""),
  { store: st.id, year, bgn, file: b.fileName || null, backup: file, mapping, overwrite: !!b.overwrite, days: changed });
  return { ok: true, imported, skipped: skippedDays, total: round2(total), bgn, created, backup: file || null, floats: floatsAll(),
    expenseColumns: data.expenseColumns, from: changed[0]?.date ?? null, to: changed.at(-1)?.date ?? null };
}

module.exports = { suggest, preview, apply };
