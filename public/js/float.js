// Оборотни пари

// ------------------------------------------------------------ Оборотни пари
// Записва разход и обновява остатъка за показания период
async function saveExpense(body) {
  const p = period();
  const r = await api("/api/expense", { ...body, store: S.store, from: p.from, to: p.to });
  for (const d of S.days) if (d.date in r.balances) d.balance = r.balances[d.date];
  S.meta.floats = r.floats;
  return r;
}

function renderFloat() {
  const last = S.days.findLast((d) => d.balance != null);
  $("#sumFloat").textContent = last ? m(last.balance) : "—";
  $("#sumFloat").className = last?.balance < 0 ? "neg" : "";
  const cell = $("#floatCell");
  if (readOnly()) {
    $("#floatInfo").textContent = last ? `към ${short(last.date, true)} · сбор за ${S.meta.stores.length} магазина` : "няма данни за периода";
    cell.disabled = true; cell.title = "Изберете магазин, за да смените оборотните пари";
    return;
  }
  const f = curFloat();
  const reset = last && f.resets.findLast((r) => r.date <= last.date);
  $("#floatInfo").textContent = last ? `към ${short(last.date, true)} · оборотни ${m(reset?.amount)}` : "няма данни за периода";
  cell.disabled = !(S.meta.isAdmin && f.current);
  cell.title = cell.disabled ? "" : "Смяна на оборотните пари за месеца";
}

const monthLabel = (s) => { const d = parse(s); return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`; };

// rows: [{ store, label, amount, note }] — по едно поле за сума на ред
function floatDialog({ title, sub, rows, okLabel, cancelLabel, onOk }) {
  showDialog(`<h2>${title}</h2><p class="sub">${sub}</p>
    ${rows.map((r, i) => `<div class="row"><label for="famount${i}" style="flex:1">${esc(r.label)}${r.note ? `<br><span class="muted">${esc(r.note)}</span>` : ""}</label>
      <input id="famount${i}" class="field amount" inputmode="decimal" value="${m(r.amount)}"></div>`).join("")}
    <div class="actions"><button class="ghost" id="cancel">${cancelLabel}</button><button class="primary" id="ok">${okLabel}</button></div>`, (root) => {
    $("#cancel", root).onclick = closeDialog;
    const ok = async () => {
      const amounts = rows.map((_, i) => toNum($(`#famount${i}`, root).value));
      if (amounts.some((n) => n === null || Number.isNaN(n) || n < 0)) return alert("Въведете сума");
      try { for (let i = 0; i < rows.length; i++) await onOk(rows[i].store, amounts[i]); closeDialog(); load(); }
      catch (err) { alert(err.message); }
    };
    $("#ok", root).onclick = ok;
    root.querySelectorAll("input").forEach((inp) => (inp.onkeydown = (e) => { if (e.key === "Enter") ok(); }));
  });
  setTimeout(() => $("#famount0")?.select(), 0);
}

function openFloat() {
  const f = curFloat(), c = f.current;
  floatDialog({
    title: multiStore() ? `Оборотни пари · ${esc(f.name)}` : "Оборотни пари",
    sub: `За ${monthLabel(c.date)}, от ${short(c.date, true)}. Остатъкът се преизчислява от тази дата.`,
    rows: [{ store: f.store, label: "Оборотни пари", amount: c.amount }], okLabel: "Запази", cancelLabel: "Отказ",
    onOk: (store, amount) => api("/api/float", { store, action: "set", amount }),
  });
}

// Нулиране в началото на месеца за всички магазини, които още не са нулирани.
// Пита се веднъж на сесия, докато админ не потвърди (на 1-во или 2-ро число).
function askFloatReset() {
  const pending = Object.values(S.meta.floats || {}).filter((f) => f.pendingReset);
  if (!S.meta.isAdmin || !pending.length || dlg.open) return;
  const key = "floatResetLater:" + pending[0].pendingReset.date;
  if (sessionStorage.getItem(key)) return;
  sessionStorage.setItem(key, "1");
  floatDialog({
    title: "Нулиране на оборотните пари",
    sub: `Започва ${monthLabel(pending[0].pendingReset.date)}. Да започне ли месецът с нова сума?`,
    rows: pending.map((f) => ({ store: f.store, label: multiStore() ? f.name : "Оборотни пари", amount: f.default,
      note: f.balance != null ? `остатък в момента ${m(f.balance)}` : "" })),
    okLabel: "Нулирай", cancelLabel: "По-късно",
    onOk: (store, amount) => api("/api/float", { store, action: "reset", amount }),
  });
}
