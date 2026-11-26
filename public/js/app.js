// Зареждане на данните, горната лента и прерисуване

// ------------------------------------------------------------ Зареждане
async function init() {
  try {
    const sess = await api("/api/session");
    if (sess.auth && !sess.user) return showAuth(sess.setup);
    S.meta = await api("/api/state");
    fixStore();
  }
  catch (e) { $("#view").innerHTML = `<div class="notice">${esc(e.message)}</div>`; return; }
  bindChrome();
  load();
}

async function load(force) {
  const p = period();
  S.loading = true; updateChrome();
  try {
    const r = await api(`/api/report?from=${p.from}&to=${p.to}&store=${S.store}${force ? "&force=1" : ""}`);
    S.days = r.days; S.syncError = r.syncError; S.meta.mappedColumns = r.mappedColumns; S.meta.floats = r.floats; S.loadedAt = new Date();
    if (r.backup) S.meta.backup = r.backup;
  } catch (e) { S.syncError = e.message; S.days = []; }
  S.loading = false;
  render();
  askBackupProblem();
  askFloatReset();
}

function updateChrome() {
  const p = period();
  $("#periodLabel").textContent = p.label;
  const range = S.mode === "range";
  $("#datePick").hidden = range; $("#rangePick").hidden = !range;
  $("#datePick").value = S.anchor;
  if (range) { $("#fromPick").value = S.from; $("#toPick").value = S.to; }
  document.querySelectorAll("#modes button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.mode === S.mode));
  $("#grouping").hidden = !canGroup();
  document.querySelectorAll("#grouping button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.group === S.group));
  document.querySelectorAll(".tabs [role=tab]").forEach((b) => b.setAttribute("aria-selected", b.dataset.tab === S.tab));
  document.querySelectorAll(".pages [data-tab]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.tab === S.tab));
  const sp = $("#storePick");
  sp.hidden = !multiStore();
  sp.innerHTML = (multiStore() ? `<option value="all">Всички магазини</option>` : "") +
    S.meta.stores.map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join("");
  sp.value = S.store;
  $("#refresh").disabled = S.loading;
  const u = S.meta.auth?.user;
  $("#who").textContent = u ? u.name : "";
  $("#logout").hidden = !u;
  document.querySelectorAll(".summary [data-sum]").forEach((b) => b.setAttribute("aria-current", b.dataset.sum === S.tab));
  $("#syncInfo").textContent = S.loading ? "Зареждане…" : S.loadedAt ? `Обновено ${S.loadedAt.toLocaleTimeString("bg-BG", { hour: "2-digit", minute: "2-digit" })}${S.meta.mock ? " · демо данни" : ""}` : "";
}

function bindChrome() {
  $("#modes").onclick = (e) => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.mode === "range" && S.mode !== "range") { const p = period(); S.from = p.from; S.to = p.to; }
    if (b.dataset.mode !== "range" && S.mode === "range") S.anchor = S.from;
    S.mode = b.dataset.mode; load();
  };
  $("#grouping").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; S.group = b.dataset.group; render(); };
  $("#prev").onclick = () => shift(-1);
  $("#next").onclick = () => shift(1);
  $("#todayBtn").onclick = () => {
    if (S.mode === "range") { S.from = addDays(today(), 1 - spanDays(S.from, S.to)); S.to = today(); }
    else S.anchor = today();
    load();
  };
  $("#datePick").onchange = (e) => { if (e.target.value) { S.anchor = e.target.value; load(); } };
  const pickRange = () => {
    let f = $("#fromPick").value, t = $("#toPick").value;
    if (!f || !t) return;
    if (f > t) [f, t] = [t, f];
    S.from = f; S.to = t; load();
  };
  $("#fromPick").onchange = pickRange;
  $("#toPick").onchange = pickRange;
  // Разходи и Приходи горе водят към таблицата; Оборотни − разходи отваря смяната на сумата
  document.querySelector(".summary").onclick = (e) => {
    const b = e.target.closest("[data-sum]"); if (!b || b.disabled) return;
    if (b.dataset.sum === "float") openFloat(); else { S.tab = b.dataset.sum; render(); }
  };
  $("#refresh").onclick = () => load(true);
  $("#themeBtn").onclick = () => { setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"); };
  $("#storePick").onchange = (e) => { S.store = e.target.value; localStorage.setItem("store", S.store); load(); };
  $("#logout").onclick = async () => { await api("/api/logout", {}).catch(() => {}); location.reload(); };
  document.querySelector(".tabs").onclick = (e) => { const b = e.target.closest("[role=tab]"); if (!b) return; S.tab = b.dataset.tab; render(); };
  // История и Настройки са горе вдясно; повторно натискане връща към Разходи
  document.querySelector(".pages").onclick = (e) => {
    const b = e.target.closest("[data-tab]"); if (!b) return;
    S.tab = S.tab === b.dataset.tab ? "expense" : b.dataset.tab; render();
  };
}
