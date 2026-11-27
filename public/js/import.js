// Импорт на разходи от Excel за минали месеци (Настройки → Импорт на разходи от Excel).
// Файлът се праща на сървъра, който връща преглед; записът е отделна стъпка.

// bgn: null = според годината (преди 2026 — лева), true/false = избрано от потребителя
const IMP = { file: null, fileName: "", store: "", year: "", bgn: null, preview: null, mapping: {}, overwrite: false, busy: false, error: "" };

function importSettings() {
  return `<h3>Импорт на разходи от Excel</h3>
    <p class="help">Внася разходите за минали месеци от Excel файл: лист за всеки месец, ред за всеки ден, колона за всеки вид разход.
      Преди записа се вижда преглед, а преди самия запис се прави резервно копие.</p>
    <button class="ghost" id="importOpen">Импорт от Excel…</button>`;
}

function openImport() {
  Object.assign(IMP, { file: null, fileName: "", bgn: null, preview: null, mapping: {}, overwrite: false, busy: false, error: "",
    store: readOnly() ? S.meta.stores[0].id : S.store, year: "" });
  drawImport();
}

const impOptions = (c) => {
  const v = IMP.mapping[c.name];
  const o = (value, label) => `<option value="${esc(value)}" ${v === value ? "selected" : ""}>${esc(label)}</option>`;
  return (v == null ? `<option value="" selected disabled>— изберете —</option>` : "")
    + expCols().map((x) => o(x.id, x.name)).join("")
    + o("new", `Нова колона „${c.name}“`) + o("", "Не внасяй");
};

const impReady = () => {
  const p = IMP.preview;
  return p && !p.errors.length && p.days > 0 && p.columns.every((c) => IMP.mapping[c.name] != null || !c.count);
};

function importPreviewHtml(p) {
  if (!p) return "";
  const list = (items, cls = "muted") => items.map((t) => `<li class="${cls}">${esc(t)}</li>`).join("");
  return `
    <p><strong>${p.days} дни с разходи</strong>${p.from ? `, ${short(p.from, true)} – ${short(p.to, true)}` : ""}, общо <strong>${m(p.total)} €</strong>
      ${p.bgn ? `<span class="muted">(преобразувани от лева)</span>` : ""}</p>
    ${p.months.length ? `<div class="scroll" style="max-height:160px"><table><thead><tr><th>Лист</th><th>Дни</th><th>Сума</th></tr></thead><tbody>
      ${p.months.map((x) => `<tr><td>${esc(x.sheet)}</td><td>${x.days}</td><td>${m(x.total)}</td></tr>`).join("")}</tbody></table></div>` : ""}
    ${p.skipped.length ? `<p class="muted">Пропуснати листове: ${esc(p.skipped.join(", "))}</p>` : ""}
    ${p.errors.length ? `<p class="err">Файлът има грешки и не може да се внесе:</p><ul>${list(p.errors, "err")}</ul>` : ""}
    ${p.warningCount ? `<details><summary class="muted">Предупреждения: ${p.warningCount}</summary><ul>${list(p.warnings)}</ul></details>` : ""}
    <h3 style="margin-top:12px">Колони</h3>
    <table class="imptable"><thead><tr><th>Във файла</th><th>Сума</th><th>В Разходи</th></tr></thead><tbody>
      ${p.columns.map((c) => `<tr><td>${esc(c.name)}</td><td>${c.count ? m(c.total) : `<span class="muted">няма суми</span>`}</td>
        <td><select data-impcol="${esc(c.name)}">${impOptions(c)}</select></td></tr>`).join("")}
    </tbody></table>
    ${p.existing.length ? `<p>${p.existing.length} от дните вече имат разходи в програмата
        <span class="muted">(${esc(p.existing.slice(0, 5).map((d) => short(d, true)).join(", "))}${p.existing.length > 5 ? "…" : ""})</span>.</p>
      <label class="row"><input type="checkbox" id="impOverwrite" ${IMP.overwrite ? "checked" : ""}>
        Замени разходите в тези дни (за колоните от файла). Иначе тези дни се пропускат.</label>` : ""}
    ${p.future ? `<p class="muted">${p.future} от дните са след днешната дата.</p>` : ""}`;
}

function drawImport() {
  const stores = S.meta.stores;
  showDialog(`<h2>Импорт на разходи от Excel</h2>
    <p class="sub">Само файлове .xlsx. Нищо не се записва, преди да натиснете „Внеси“.</p>
    ${stores.length > 1 ? `<div class="row"><span class="muted" style="width:80px">Магазин</span>
      <select class="field" id="impStore">${stores.map((s) => `<option value="${esc(s.id)}" ${s.id === IMP.store ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select></div>` : ""}
    <div class="row"><span class="muted" style="width:80px">Файл</span>
      ${IMP.fileName ? `<strong>${esc(IMP.fileName)}</strong>` : ""}
      <label class="ghost filepick">${IMP.fileName ? "Друг файл…" : "Изберете файл…"}<input type="file" id="impFile" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"></label></div>
    ${IMP.fileName ? `<div class="row"><span class="muted" style="width:80px">Година</span><input class="field" id="impYear" inputmode="numeric" style="flex:0 0 90px" value="${esc(IMP.preview?.year || IMP.year)}">
      <span class="muted">Годината на дните (във файла има само месеци)</span></div>
    <label class="row"><input type="checkbox" id="impBgn" ${IMP.preview?.bgn ?? IMP.bgn ? "checked" : ""}>
      Сумите във файла са в лева — раздели ги на ${esc(String(IMP.preview?.rate ?? 1.95583).replace(".", ","))} (в евро)</label>` : ""}
    ${IMP.busy ? `<p class="muted">Чете се…</p>` : ""}
    ${IMP.error ? `<p class="err">${esc(IMP.error)}</p>` : ""}
    ${importPreviewHtml(IMP.preview)}
    <div class="actions"><button class="ghost" id="cancel">Затвори</button>
      <button class="primary" id="impApply" ${impReady() && !IMP.busy ? "" : "disabled"}>Внеси</button></div>`, bindImport);
}

function bindImport(root) {
  $("#cancel", root).onclick = closeDialog;
  $("#impFile", root).onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    IMP.fileName = f.name; IMP.year = ""; IMP.bgn = null; IMP.preview = null; IMP.mapping = {};
    const bytes = new Uint8Array(await f.arrayBuffer());
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    IMP.file = btoa(bin);
    importPreview();
  };
  if ($("#impStore", root)) $("#impStore", root).onchange = (e) => { IMP.store = e.target.value; if (IMP.file) importPreview(); };
  if ($("#impYear", root)) $("#impYear", root).onchange = (e) => { IMP.year = e.target.value.trim(); IMP.bgn = null; importPreview(); };
  if ($("#impBgn", root)) $("#impBgn", root).onchange = (e) => { IMP.bgn = e.target.checked; importPreview(); };
  if ($("#impOverwrite", root)) $("#impOverwrite", root).onchange = (e) => { IMP.overwrite = e.target.checked; };
  root.querySelectorAll("[data-impcol]").forEach((sel) => {
    sel.onchange = () => { IMP.mapping[sel.dataset.impcol] = sel.value; $("#impApply", root).disabled = !impReady(); };
  });
  $("#impApply", root).onclick = importApply;
}

const impBody = () => ({ store: IMP.store, file: IMP.file, fileName: IMP.fileName, year: IMP.year, ...(IMP.bgn == null ? {} : { bgn: IMP.bgn }) });

async function importPreview() {
  IMP.busy = true; IMP.error = ""; drawImport();
  try {
    const p = await api("/api/import/preview", impBody());
    IMP.preview = p; IMP.year = String(p.year); IMP.bgn = p.bgn;
    // Предложенията се попълват само за колоните, които още не са избрани
    for (const c of p.columns) if (IMP.mapping[c.name] == null && (c.suggest || !c.count)) IMP.mapping[c.name] = c.suggest || "";
  } catch (err) { IMP.preview = null; IMP.error = err.message; }
  IMP.busy = false;
  if (dlg.open) drawImport();
}

async function importApply() {
  IMP.busy = true; IMP.error = ""; drawImport();
  try {
    const r = await api("/api/import/apply", { ...impBody(), mapping: IMP.mapping, overwrite: IMP.overwrite });
    await refreshMeta();
    load();
    showDialog(`<h2>Разходите са внесени</h2>
      <p>Внесени: <strong>${r.imported} дни</strong>${r.from ? ` (${short(r.from, true)} – ${short(r.to, true)})` : ""}, общо <strong>${m(r.total)} €</strong>${r.bgn ? " (преобразувани от лева)" : ""}.</p>
      ${r.skipped ? `<p>Пропуснати ${r.skipped} дни, които вече имаха разходи.</p>` : ""}
      ${r.created.length ? `<p>Нови колони в Разходи: ${esc(r.created.join(", "))}.</p>` : ""}
      <p class="muted">Импортът е записан в История.${r.backup ? ` Преди него е направено резервно копие: ${esc(r.backup)}.` : ""}</p>
      <div class="actions"><button class="primary" id="cancel">Затвори</button></div>`,
      (root) => { $("#cancel", root).onclick = closeDialog; });
  } catch (err) {
    IMP.busy = false; IMP.error = err.message;
    if (dlg.open) drawImport();
  }
}

document.addEventListener("click", (e) => { if (e.target.id === "importOpen") openImport(); });
