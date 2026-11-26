// Диалози: продажби за ден, Разни, колони

// ------------------------------------------------------------ Диалози
const dlg = $("#dlg");
function showDialog(html, onBind) { $("#dlgBody").innerHTML = html; onBind?.($("#dlgBody")); if (!dlg.open) dlg.showModal(); }
function closeDialog() { dlg.close(); }
dlg.addEventListener("click", (e) => { if (e.target === dlg) closeDialog(); });
// След затваряне на прозорец се показва следващото чакащо предупреждение, ако има
dlg.addEventListener("close", () => setTimeout(() => { if (S.meta) { askBackupProblem(); askDbProblem(); askFloatReset(); } }, 0));
const dateLabel = (s) => { const d = parse(s); return `${WD[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`; };

async function openRevenue(date, colId) {
  const col = revCols().find((c) => c.id === colId), day = S.days.find((d) => d.date === date);
  const edited = day.edited.includes(colId);
  const head = `<h2>${esc(col.name)}</h2><p class="sub">${dateLabel(date)}</p>`;
  const form = (detailHtml) => `${head}${detailHtml}
    <div class="row"><label for="ov" style="flex:0 0 auto">Ръчна стойност</label>
      <input id="ov" class="field amount" inputmode="decimal" value="${edited ? m(day.revenue[colId]) : ""}" placeholder="${m(day.revenueApi[colId])}"></div>
    <p class="muted" style="margin:4px 0 0">Оставете празно, за да се ползва сумата от Microinvest.</p>
    <div class="actions">${edited ? `<button class="danger" id="clr">Премахни корекцията</button>` : ""}
      <button class="ghost" id="cancel">Затвори</button><button class="primary" id="save">Запази</button></div>`;
  const bind = (root) => {
    $("#cancel", root).onclick = closeDialog;
    const save = async (value) => {
      try {
        await api("/api/revenue", { store: S.store, date, col: colId, value });
        day.revenue[colId] = value ?? day.revenueApi[colId];
        day.edited = day.edited.filter((x) => x !== colId).concat(value === null ? [] : [colId]);
        closeDialog(); render();
      } catch (err) { alert(err.message); }
    };
    $("#save", root).onclick = () => { const n = toNum($("#ov", root).value); if (Number.isNaN(n)) return alert("Невалидно число"); save(n); };
    $("#ov", root).onkeydown = (e) => { if (e.key === "Enter") $("#save", root).click(); };
    if ($("#clr", root)) $("#clr", root).onclick = () => save(null);
  };
  showDialog(form(`<p class="muted">Зареждане на продажбите…</p>`), bind);
  try {
    const { lines } = await api(`/api/detail?date=${date}&col=${encodeURIComponent(colId)}&store=${S.store}`);
    const total = lines.reduce((s, l) => s + l.amount, 0);
    const tbl = lines.length
      ? `<div class="scroll"><table><thead><tr><th>Артикул</th><th style="text-align:right">К-во</th><th style="text-align:right">Сума</th><th style="text-align:right">Док. №</th></tr></thead><tbody>
          ${lines.map((l) => `<tr><td>${esc(l.name)}</td><td>${qfmt.format(l.qtty)}</td><td>${m(l.amount)}</td><td class="muted">${l.docs.slice(0, 3).join(", ")}${l.docs.length > 3 ? "…" : ""}</td></tr>`).join("")}
        </tbody><tfoot><tr><td><strong>От Microinvest</strong></td><td></td><td><strong>${m(total)}</strong></td><td></td></tr></tfoot></table></div>`
      : `<p class="muted">Няма продажби в Microinvest за тази колона на тази дата.</p>`;
    if (dlg.open) showDialog(form(tbl), bind);
  } catch (err) {
    if (dlg.open) showDialog(form(`<p class="err">${esc(err.message)}</p>`), bind);
  }
}

function openList(date, colId) {
  const col = expCols().find((c) => c.id === colId), day = S.days.find((d) => d.date === date);
  let items = (day.expenses[colId] || []).map((i) => ({ ...i }));
  if (!items.length) items.push({ name: "", value: null });
  const draw = () => showDialog(`<h2>${esc(col.name)}</h2><p class="sub">${dateLabel(date)}</p>
    <div id="lines">${items.map((it, i) => `<div class="row">
      <input class="field" data-i="${i}" data-f="name" placeholder="Описание" value="${esc(it.name)}">
      <input class="field amount" data-i="${i}" data-f="value" inputmode="decimal" placeholder="0,00" value="${it.value != null ? m(it.value) : ""}">
      <button class="x" data-del="${i}" aria-label="Премахни реда">×</button></div>`).join("")}</div>
    <button class="ghost" id="addLine">+ Ред</button>
    <div class="actions"><button class="ghost" id="cancel">Затвори</button><button class="primary" id="save">Запази</button></div>`, (root) => {
      root.querySelectorAll("[data-f]").forEach((inp) => inp.oninput = () => { inp.setCustomValidity(""); const it = items[inp.dataset.i]; if (inp.dataset.f === "name") it.name = inp.value; else it.value = toNum(inp.value); });
      // Enter: от описанието към сумата; от сумата — нов ред, ако сумата е валидна.
      // Enter на празен последен ред запазва.
      const field = (i, f) => root.querySelector(`[data-i="${i}"][data-f=${f}]`);
      root.querySelectorAll("[data-f]").forEach((inp) => inp.onkeydown = (e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        const i = +inp.dataset.i, it = items[i], last = i === items.length - 1;
        if (last && items.length > 1 && !it.name.trim() && it.value === null) return $("#save", root).click();
        if (inp.dataset.f === "name") { field(i, "value").focus(); return; }
        if (it.value === null || Number.isNaN(it.value)) {
          inp.setCustomValidity(it.value === null ? "Въведете сума" : "Невалидно число");
          inp.reportValidity();
          return;
        }
        inp.value = m(it.value);
        if (!last) { field(i + 1, "name").focus(); return; }
        items.push({ name: "", value: null }); draw();
        field(items.length - 1, "name")?.focus();
      });
      root.querySelectorAll("[data-del]").forEach((b) => b.onclick = () => { items.splice(+b.dataset.del, 1); if (!items.length) items.push({ name: "", value: null }); draw(); });
      $("#addLine", root).onclick = () => { items.push({ name: "", value: null }); draw(); root.querySelector(`[data-i="${items.length - 1}"][data-f=name]`)?.focus(); };
      $("#cancel", root).onclick = closeDialog;
      $("#save", root).onclick = async () => {
        if (items.some((i) => Number.isNaN(i.value))) return alert("Има невалидна сума");
        try {
          const r = await saveExpense({ date, col: colId, items });
          if (r.value) day.expenses[colId] = r.value; else delete day.expenses[colId];
          closeDialog(); render();
        } catch (err) { alert(err.message); }
      };
    });
  draw();
  setTimeout(() => $("#dlgBody [data-f=name]")?.focus(), 0);
}

function openAddColumn(table) {
  showDialog(`<h2>Нова колона в ${table === "revenue" ? "Приходи" : "Разходи"}</h2>
    <div class="row"><input class="field" id="cname" placeholder="Име на колоната"></div>
    ${table === "expense" ? `<label class="row"><input type="checkbox" id="ckind"> Няколко записа с име и стойност на ден (като „Разни“)</label>` : ""}
    ${table === "revenue" ? `<p class="muted">Стойностите се въвеждат ръчно. За да идват от Microinvest, свържете групи артикули с колоната в Настройки.</p>` : ""}
    <div class="actions"><button class="ghost" id="cancel">Отказ</button><button class="primary" id="ok">Добави</button></div>`, (root) => {
    $("#cancel", root).onclick = closeDialog;
    const ok = async () => {
      try {
        await api("/api/columns", { table, action: "add", name: $("#cname", root).value, kind: $("#ckind", root)?.checked ? "list" : undefined });
        closeDialog(); await refreshMeta(); load();
      } catch (err) { alert(err.message); }
    };
    $("#ok", root).onclick = ok;
    $("#cname", root).onkeydown = (e) => { if (e.key === "Enter") ok(); };
  });
  setTimeout(() => $("#cname")?.focus(), 0);
}

function openColumn(table, id) {
  const list = table === "revenue" ? revCols() : expCols(), col = list.find((c) => c.id === id);
  showDialog(`<h2>Колона „${esc(col.name)}“</h2>
    <div class="row"><input class="field" id="cname" value="${esc(col.name)}"></div>
    <div class="row"><button class="ghost" id="left">← Наляво</button><button class="ghost" id="right">Надясно →</button></div>
    <div class="actions"><button class="danger" id="del">Изтрий колоната</button><button class="ghost" id="cancel">Отказ</button><button class="primary" id="ok">Запази</button></div>`, (root) => {
    const act = async (body) => { try { await api("/api/columns", { table, id, ...body }); await refreshMeta(); load(); return true; } catch (err) { alert(err.message); } };
    $("#cancel", root).onclick = closeDialog;
    $("#ok", root).onclick = async () => { if (await act({ action: "rename", name: $("#cname", root).value })) closeDialog(); };
    $("#left", root).onclick = () => act({ action: "move", dir: -1 });
    $("#right", root).onclick = () => act({ action: "move", dir: 1 });
    $("#del", root).onclick = async () => {
      if (!confirm(`Да изтрия ли колоната „${col.name}“? Въведените в нея стойности няма да се показват.`)) return;
      if (await act({ action: "delete" })) closeDialog();
    };
  });
}

async function refreshMeta() { S.meta = await api("/api/state"); }
