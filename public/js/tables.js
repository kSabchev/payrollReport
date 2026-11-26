// Таблиците Разходи и Приходи и въвеждането в тях

// ------------------------------------------------------------ Рендиране
function render() {
  updateChrome();
  renderAlerts();
  $("#sumRev").textContent = m(sum(S.days, revTotal));
  $("#sumExp").textContent = m(sum(S.days, expTotal));
  renderFloat();

  // запазване на фокуса между прерисуванията
  const focusKey = document.activeElement?.dataset?.key;

  const notice = (S.syncError ? `<div class="notice">${esc(S.syncError)} Показват се запазените данни.</div>` : "") +
    (readOnly() && (S.tab === "revenue" || S.tab === "expense") ? `<p class="muted" style="margin:8px 2px 0">Сбор от всички магазини. За да въвеждате, изберете магазин горе вляво.</p>` : "");
  let html = "";
  if (S.tab === "revenue") html = revenueTable();
  else if (S.tab === "expense") html = expenseTable();
  else if (S.tab === "history") { html = historyFrame(); setTimeout(loadHistory); }
  else html = settingsView();
  $("#view").innerHTML = (S.tab === "revenue" || S.tab === "expense" ? notice : "") + html;

  if (focusKey) { const el = document.querySelector(`[data-key="${CSS.escape(focusKey)}"]`); if (el) { el.focus(); el.select?.(); } }
}

function rowHead(r) {
  if (r.day) {
    const d = parse(r.key);
    return `<th><button data-goday="${r.key}" title="Отвори деня">${WD[d.getDay()]} ${pad(d.getDate())}.${pad(d.getMonth() + 1)}</button></th>`;
  }
  const [y, mo] = r.key.split("-").map(Number);
  return `<th><button data-gomonth="${r.key}" title="Отвори месеца">${cap(MONTHS[mo - 1])}</button></th>`;
}
function rowClass(r) {
  if (!r.day) return "";
  const d = parse(r.key), c = [];
  if (d.getDay() === 0) c.push("sunday"); // съботата е работен ден
  if (r.key === today()) c.push("today");
  if (r.key > today()) c.push("future");
  return c.join(" ");
}
// Колоните се добавят, преименуват, подреждат и трият в Настройки → Колони
// Колоните в Приходи имат постоянен цвят; новите колони взимат следващия свободен
const COL_COLORS = { service: "--c-service", prima: "--c-prima", phones: "--c-phones", goods: "--c-goods" };
const EXTRA_COLORS = ["--c-5", "--c-6", "--c-7"];
function colColor(c) {
  if (COL_COLORS[c.id]) return `var(${COL_COLORS[c.id]})`;
  const extra = revCols().filter((x) => !COL_COLORS[x.id]).findIndex((x) => x.id === c.id);
  return `var(${EXTRA_COLORS[Math.max(0, extra) % EXTRA_COLORS.length]})`;
}
const colHead = (table, c) => table === "revenue"
  ? `<th class="col" style="--col:${colColor(c)}">${esc(c.name)}</th>` : `<th>${esc(c.name)}</th>`;
const addHead = () => `<th></th>`;

// Фон според сумата: колкото по-голяма спрямо най-голямата в колоната, толкова по-наситен
function heatMax(R, f) { return Math.max(0, ...R.map((r) => sum(r.days, f))); }
function heat(v, max, kind) {
  if (!(v > 0) || !(max > 0)) return { cls: "", style: "" };
  return { cls: `heat-${kind}`, style: ` style="--t:${(4 + 22 * v / max).toFixed(1)}%"` };
}

function revenueTable() {
  const cols = revCols(), mapped = new Set(S.meta.mappedColumns), R = rows();
  if (!R.length) return `<div class="tablewrap"><div class="empty">Няма данни за периода.</div></div>`;
  const max = Object.fromEntries(cols.map((c) => [c.id, heatMax(R, (d) => d.revenue[c.id] || 0)]));
  const body = R.map((r) => {
    const cells = cols.map((c) => {
      const h = heat(sum(r.days, (d) => d.revenue[c.id] || 0), max[c.id], "rev");
      if (!r.day || readOnly()) return `<td class="${h.cls}"${h.style}><span class="v">${mOrBlank(sum(r.days, (d) => d.revenue[c.id] || 0))}</span></td>`;
      const d = r.day, v = d.revenue[c.id] || 0, edited = d.edited.includes(c.id), key = `rev|${d.date}|${c.id}`;
      if (mapped.has(c.id)) {
        const title = edited ? `Ръчна стойност. Microinvest: ${m(d.revenueApi[c.id])}` : "Покажи продажбите от Microinvest";
        return `<td class="${edited ? "edited" : ""} ${h.cls}"${h.style}><button class="cell" data-key="${key}" data-revdetail="${d.date}|${c.id}" title="${title}">${mOrBlank(v) || (edited ? "0,00" : "&nbsp;")}</button></td>`;
      }
      return `<td class="${h.cls}"${h.style}><input data-key="${key}" data-rev="${d.date}|${c.id}" inputmode="decimal" value="${v ? m(v) : ""}" aria-label="${esc(c.name)} ${d.date}"></td>`;
    }).join("");
    return `<tr class="${rowClass(r)}">${rowHead(r)}<td class="total"><span class="v">${m(sum(r.days, revTotal))}</span></td>${cells}<td></td></tr>`;
  }).join("");
  const foot = cols.map((c) => `<td>${m(sum(S.days, (d) => d.revenue[c.id] || 0))}</td>`).join("");
  return `<div class="tablewrap"><table class="grid">
    <thead><tr><th>${byGroupRows() ? "Месец" : "Дата"}</th><th class="total">Обща стойност</th>${cols.map((c) => colHead("revenue", c)).join("")}${addHead("revenue")}</tr></thead>
    <tbody>${body}</tbody>
    <tfoot><tr><th>Общо</th><td>${m(sum(S.days, revTotal))}</td>${foot}<td></td></tr></tfoot></table></div>`;
}

function expenseTable() {
  const cols = expCols(), R = rows();
  if (!R.length) return `<div class="tablewrap"><div class="empty">Няма данни за периода.</div></div>`;
  const max = Object.fromEntries(cols.map((c) => [c.id, heatMax(R, (d) => expVal(d, c))]));
  const body = R.map((r) => {
    const cells = cols.map((c) => {
      const h = heat(sum(r.days, (d) => expVal(d, c)), max[c.id], "exp");
      if (!r.day || readOnly()) return `<td class="${h.cls}"${h.style}><span class="v">${mOrBlank(sum(r.days, (d) => expVal(d, c)))}</span></td>`;
      const d = r.day, key = `exp|${d.date}|${c.id}`;
      if (c.kind === "list") {
        const list = d.expenses[c.id] || [];
        const title = list.length ? list.map((i) => `${i.name || "—"}: ${m(i.value)}`).join("\n") : "Добави разходи с име и стойност";
        return `<td class="${h.cls}"${h.style}><button class="cell" data-key="${key}" data-explist="${d.date}|${c.id}" title="${esc(title)}">${list.length ? m(expVal(d, c)) + (list.length > 1 ? ` <span class="muted">(${list.length})</span>` : "") : "&nbsp;"}</button></td>`;
      }
      const v = d.expenses[c.id];
      return `<td class="${h.cls}"${h.style}><input data-key="${key}" data-exp="${d.date}|${c.id}" inputmode="decimal" value="${v != null ? m(v) : ""}" aria-label="${esc(c.name)} ${d.date}"></td>`;
    }).join("");
    return `<tr class="${rowClass(r)}">${rowHead(r)}<td class="total"><span class="v">${m(sum(r.days, expTotal))}</span></td>${balCell(r.days)}${cells}<td></td></tr>`;
  }).join("");
  const foot = cols.map((c) => `<td>${m(sum(S.days, (d) => expVal(d, c)))}</td>`).join("");
  const endBal = lastBalance(S.days);
  return `<div class="tablewrap"><table class="grid">
    <thead><tr><th>${byGroupRows() ? "Месец" : "Дата"}</th><th class="total">Общо</th><th title="Оборотни пари минус разходите от началото на месеца">Остатък</th>${cols.map((c) => colHead("expense", c)).join("")}${addHead("expense")}</tr></thead>
    <tbody>${body}</tbody>
    <tfoot><tr><th>Общо</th><td>${m(sum(S.days, expTotal))}</td><td class="${balClass(S.days)}">${endBal == null ? "" : m(endBal)}</td>${foot}<td></td></tr></tfoot></table></div>`;
}

// Остатък в края на последния ден с изчислена стойност
const lastBalance = (days) => days.findLast((d) => d.balance != null)?.balance ?? null;
// Оборотните пари, валидни за деня (при „Всички“ — сборът на магазините)
function floatAmountOn(date) {
  const fl = readOnly() ? Object.values(S.meta.floats || {}) : [curFloat()].filter(Boolean);
  return fl.reduce((s, f) => s + (f.resets.findLast((r) => r.date <= date)?.amount || 0), 0);
}
// Остатък: червено под нулата, жълто под 20% от оборотните пари
function balClass(days) {
  const d = days.findLast((x) => x.balance != null);
  if (!d) return "muted";
  if (d.balance < 0) return "bal-neg";
  const amount = floatAmountOn(d.date);
  return amount > 0 && d.balance < amount * 0.2 ? "bal-low" : "muted";
}
function balCell(days) {
  const b = lastBalance(days), cls = balClass(days);
  const title = cls === "bal-low" ? ` title="Остават под 20% от оборотните пари"` : cls === "bal-neg" ? ` title="Разходите надвишават оборотните пари"` : "";
  return `<td class="${cls}"${title}><span class="v">${b == null ? "" : m(b)}</span></td>`;
}

// ------------------------------------------------------------ Редакция в таблицата
document.addEventListener("change", async (e) => {
  const t = e.target;
  if (!t.dataset.exp && !t.dataset.rev) return;
  const [date, col] = (t.dataset.exp || t.dataset.rev).split("|");
  const n = toNum(t.value);
  if (Number.isNaN(n)) { t.setCustomValidity("Невалидно число"); t.reportValidity(); return; }
  t.setCustomValidity("");
  const day = S.days.find((d) => d.date === date);
  try {
    if (t.dataset.exp) {
      const r = await saveExpense({ date, col, value: n });
      if (r.value === null) delete day.expenses[col]; else day.expenses[col] = r.value;
    } else {
      await api("/api/revenue", { store: S.store, date, col, value: n });
      day.revenue[col] = n ?? day.revenueApi[col];
      day.edited = day.edited.filter((x) => x !== col).concat(n === null ? [] : [col]);
    }
    render();
  } catch (err) { alert(err.message); }
});

// Enter / стрелки — към клетката под/над
document.addEventListener("keydown", (e) => {
  const t = e.target;
  if (!(t.dataset?.key) || !["Enter", "ArrowDown", "ArrowUp"].includes(e.key)) return;
  if (t.tagName === "BUTTON" && e.key === "Enter") return;
  const [tbl, date, col] = t.dataset.key.split("|");
  const keys = [...document.querySelectorAll(`[data-key^="${tbl}|"][data-key$="|${col}"]`)];
  const i = keys.indexOf(t), next = keys[i + (e.key === "ArrowUp" ? -1 : 1)];
  if (next) { e.preventDefault(); next.focus(); next.select?.(); }
});

document.addEventListener("click", (e) => {
  const t = e.target.closest("button");
  if (!t) return;
  const d = t.dataset;
  if (d.goday) { S.mode = "day"; S.anchor = d.goday; load(); }
  else if (d.gomonth) { S.mode = "month"; S.anchor = d.gomonth + "-01"; load(); }
  else if (d.revdetail) openRevenue(...d.revdetail.split("|"));
  else if (d.explist) openList(...d.explist.split("|"));
  else if (d.addcol) openAddColumn(d.addcol);
  else if (d.colmenu) openColumn(...d.colmenu.split("|"));
});
