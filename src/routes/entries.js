// Въвеждане по магазин: разходи, ръчни приходи, оборотни пари
const { fmt, isDate, monthStart, num, dmy, showVal, same } = require("../util");
const { data, saveData } = require("../data");
const { audit } = require("../history");
const { sd, storeParam, storeLabel, recomputeFloat, activeReset, floatsAll, balancesFor } = require("../stores");

module.exports = {
  "POST /api/expense": async (_, b, user) => {
    const st = storeParam(b.store), { expenses } = sd(st);
    if (!isDate(b.date) || !data.expenseColumns.some((c) => c.id === b.col)) throw new Error("Невалидни данни");
    const col = data.expenseColumns.find((c) => c.id === b.col);
    const day = (expenses[b.date] ||= {});
    const before = structuredClone(day[b.col] ?? null);
    if (col.kind === "list") {
      const items = (b.items || []).map((i) => ({ name: String(i.name || "").trim(), value: num(i.value) })).filter((i) => i.value !== null);
      if (items.length) day[b.col] = items; else delete day[b.col];
    } else {
      const v = num(b.value);
      if (v === null) delete day[b.col]; else day[b.col] = v;
    }
    const after = day[b.col] ?? null;
    if (!Object.keys(day).length) delete expenses[b.date];
    recomputeFloat(st);
    saveData();
    if (!same(before, after))
      audit(user, "expense", `${storeLabel(st)}Разход ${dmy(b.date)} · ${col.name}: ${showVal(before)} → ${showVal(after)}`,
        { store: st.id, date: b.date, col: b.col, before, after });
    const balances = isDate(b.from) && isDate(b.to) && b.from <= b.to ? balancesFor(st, b.from, b.to) : {};
    return { ok: true, value: after, balances, floats: floatsAll() };
  },

  // action "set" — променя сумата на текущия месец; "reset" — нулира от 1-во число на месеца
  "POST /api/float": async (_, b, user) => {
    const st = storeParam(b.store), { float } = sd(st);
    const amount = num(b.amount);
    if (amount === null || amount < 0) throw new Error("Въведете сума на оборотните пари");
    let text;
    if (b.action === "set") {
      const r = activeReset(st);
      if (!r) throw new Error("Няма начална сума на оборотните пари");
      text = `Оборотни пари от ${dmy(r.date)}: ${showVal(r.amount)} → ${showVal(amount)}`;
      r.amount = amount;
    } else if (b.action === "reset") {
      const date = monthStart(fmt(new Date()));
      const r = float.find((x) => x.date === date);
      text = `Нулиране на оборотните пари от ${dmy(date)}: ${showVal(amount)}`;
      if (r) Object.assign(r, { amount, at: Date.now() });
      else float.push({ date, amount, at: Date.now() });
      float.sort((x, y) => x.date.localeCompare(y.date));
    } else throw new Error("Невалидно действие");
    st.floatDefault = amount;
    recomputeFloat(st);
    saveData();
    audit(user, "float", storeLabel(st) + text, { store: st.id, op: b.action, amount });
    return { ok: true, floats: floatsAll() };
  },

  "POST /api/revenue": async (_, b, user) => {
    const st = storeParam(b.store), { revenueManual } = sd(st);
    const col = data.revenueColumns.find((c) => c.id === b.col);
    if (!isDate(b.date) || !col) throw new Error("Невалидни данни");
    const day = (revenueManual[b.date] ||= {});
    const before = day[b.col] ?? null;
    const v = num(b.value);
    if (v === null) delete day[b.col]; else day[b.col] = v;
    if (!Object.keys(day).length) delete revenueManual[b.date];
    saveData();
    if (!same(before, v)) {
      const show = (x) => (x == null ? "от Microinvest" : showVal(x));
      audit(user, "revenue", `${storeLabel(st)}Приход ${dmy(b.date)} · ${col.name}: ${show(before)} → ${show(v)}`,
        { store: st.id, date: b.date, col: b.col, before, after: v });
    }
    return { ok: true };
  },
};
