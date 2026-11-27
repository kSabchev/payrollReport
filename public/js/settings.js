// Раздел Настройки

// ------------------------------------------------------------ Настройки
function accessHelp() {
  const a = S.meta.auth, b = S.meta.backup;
  const access = !a?.enabled ? `<p class="help">Демо режим: няма вход.</p>` : usersView(a);
  let backup = "";
  if (b && !b.mock) {
    const when = b.at ? new Date(b.at).toLocaleString("bg-BG") : null;
    backup = `<p class="help">Всеки ден в ${esc(b.time)} се прави копие на данните в <strong>${esc(b.dir)}</strong>.
      Ако програмата не е работила в този час, копието се прави веднага при следващото стартиране. Копията не се трият
      (в момента: ${b.count}). ${when ? `Последно копие: ${esc(when)} (${esc(b.file)}).` : "Още няма копие."}
      В копията няма продажбите — те се изтеглят наново от Microinvest.</p>
      <p class="help">${b.copy ? `Всяко копие се записва и във втора папка: <strong>${esc(b.copy.dir)}</strong>.
        ${b.copy.error ? "" : b.copy.at ? `Последно копиране там: ${esc(new Date(b.copy.at).toLocaleString("bg-BG"))}.` : ""}
        <span class="muted">Програмата работи като Windows потребител „${esc(b.copy.runAs)}“${b.copy.login
          ? `; с мрежовата папка се свързва като „${esc(b.copy.login)}“` : ""}.</span>`
        : `Втора папка за копията (друг диск или NAS) не е настроена. Задава се с BACKUP_COPY_DIR в .env.`}</p>
      ${b.problem ? `<p class="err">${esc(backupProblemText(b))}</p>` : ""}
      <div class="actions" style="justify-content:flex-start;margin-top:0"><button class="ghost" data-backupnow>Направи копие сега</button><span id="backupMsg" class="muted"></span></div>`;
  }
  return `<h3>Акаунти</h3>${access}<h3>Резервни копия</h3>${backup || `<p class="help">В демо режим не се правят копия.</p>`}`;
}

function settingsView() {
  const s = S.meta.settings, cols = revCols();
  const opts = (sel, withInherit) => (withInherit ? `<option value="">— автоматично —</option>` : "") +
    cols.map((c) => `<option value="${c.id}" ${sel === c.id ? "selected" : ""}>${esc(c.name)}</option>`).join("");
  const groups = S.meta.groups || [];
  const level = (g) => Math.max(0, Math.floor(String(g.code || "").length / 3) - 1);
  return `<div class="settings">
    <h3>Връзка с базата на Microinvest Склад Про</h3>
    ${connHelp(S.meta.connection)}
    <div class="actions" style="justify-content:flex-start;margin-top:0"><button class="ghost" id="saveConn">Провери връзката</button><span id="connMsg" class="muted"></span></div>

    ${storesSettings()}

    <details class="fold" id="groupsFold" ${S.groupsOpen ? "open" : ""}>
      <summary>Групи артикули → колони в Приходи
        <span class="muted">${groups.length ? `${groups.length} групи, ${groups.filter((g) => S.meta.groupMap[g.id]).length} с избрана колона` : ""}</span></summary>
      <p class="help">Всяка продажба отива в колоната на групата на артикула. Подгрупите наследяват колоната на родителската група. Продажбите от групи без избрана колона отиват в:
        <select id="sDefault" class="field" style="flex:none;padding:4px 8px">${opts(s.defaultRevenueColumn)}</select></p>
      ${groups.length ? `<table class="maptable"><thead><tr><th>Група в Microinvest</th><th>Колона</th></tr></thead><tbody>
        ${groups.map((g) => `<tr><td style="padding-left:${10 + level(g) * 20}px">${esc(g.name)} <span class="muted">${esc(g.code)}</span></td>
          <td><select data-group="${g.id}">${opts(S.meta.groupMap[g.id] || "", true)}</select></td></tr>`).join("")}
      </tbody></table>` : `<p class="muted">Групите ще се покажат след успешна връзка с Microinvest.</p>`}
    </details>
    ${S.meta.catalogError ? `<p class="err">${esc(S.meta.catalogError)}</p>` : ""}

    <h3>Колони</h3>
    <p class="help">Натиснете колона, за да я преименувате, преместите наляво или надясно, или изтриете. С „+ Колона“ се добавя нова.
      Промените важат за всички магазини.</p>
    <div class="row"><span class="muted" style="width:80px">Приходи</span><div class="collist">${revCols().map((c) => `<button data-colmenu="revenue|${c.id}">${esc(c.name)}</button>`).join("")}<button data-addcol="revenue">+ Колона</button></div></div>
    <div class="row"><span class="muted" style="width:80px">Разходи</span><div class="collist">${expCols().map((c) => `<button data-colmenu="expense|${c.id}">${esc(c.name)}</button>`).join("")}<button data-addcol="expense">+ Колона</button></div></div>

    ${importSettings()}

    <h3>Данни от Microinvest</h3>
    <p class="help">Продажбите се пазят локално след първото зареждане, а последните 3 дни се четат наново всеки път. Ако сте коригирали стари документи в Microinvest, изтеглете всичко наново.</p>
    <button class="ghost" id="clearCache">Изтегли всичко наново</button>

    ${accessHelp()}
  </div>`;
}

// Потребителят и паролата за базата са само в .env на сървъра — не се виждат и не се сменят оттук
function connHelp(c) {
  if (!c || c.mock) return `<p class="help">Демо режим: продажбите са примерни и не се четат от база.</p>`;
  if (!c.configured) return `<p class="err">Връзката с базата не е настроена. Попълнете файла .env до server.js (вижте .env.example) и рестартирайте програмата.</p>`;
  return `<p class="help">Сървър <strong>${esc(c.server)}</strong>, база <strong>${esc(c.database)}</strong>, потребител <strong>${esc(c.user)}</strong> (само за четене).
    Тези данни се сменят във файла .env на сървъра.</p>`;
}

// Свитата/разгънатата таблица с групи се помни между прерисуванията
document.addEventListener("toggle", (e) => { if (e.target.id === "groupsFold") S.groupsOpen = e.target.open; }, true);

document.addEventListener("click", async (e) => {
  if (e.target.dataset?.tabGo) { S.tab = e.target.dataset.tabGo; render(); return; }
  if (e.target.id === "saveConn") {
    const msg = $("#connMsg");
    msg.textContent = "Проверка…"; msg.className = "muted";
    try {
      await refreshMeta();
      if (S.meta.catalogError) throw new Error(S.meta.catalogError);
      render();
      $("#connMsg").textContent = `Връзката работи. Групи: ${S.meta.groups.length}.`;
      load();
    } catch (err) { render(); $("#connMsg").textContent = err.message; $("#connMsg").className = "err"; }
  }
  if (e.target.id === "addStore") openStore();
  if (e.target.dataset?.storeedit) openStore(e.target.dataset.storeedit);
  if (e.target.dataset?.storedel) {
    const st = S.meta.stores.find((x) => x.id === e.target.dataset.storedel);
    if (!confirm(`Да изтрия ли магазина „${st.name}“?`)) return;
    try { await api("/api/stores", { action: "delete", id: st.id }); await refreshMeta(); fixStore(); load(); }
    catch (err) { alert(err.message); }
  }
  if (e.target.id === "addUser") openUser();
  if (e.target.dataset?.userpw) openUser(e.target.dataset.userpw);
  if (e.target.dataset?.userdel) {
    const name = e.target.dataset.userdel;
    if (!confirm(`Да изтрия ли акаунта „${name}“?`)) return;
    try { const r = await api("/api/users", { action: "delete", username: name }); S.meta.auth.users = r.users; render(); }
    catch (err) { alert(err.message); }
  }
  if (e.target.dataset?.backupnow !== undefined) backupNow();
  if (e.target.dataset?.histkind !== undefined) { S.histKind = e.target.dataset.histkind; render(); }
  if (e.target.id === "clearCache") {
    if (!confirm("Да изтегля ли наново всички продажби от Microinvest? Ръчните стойности се запазват.")) return;
    await api("/api/clear-cache", {}); load();
  }
});
document.addEventListener("change", async (e) => {
  const t = e.target;
  try {
    if (t.dataset?.group) { await api("/api/groupmap", { groupId: t.dataset.group, col: t.value || null }); await refreshMeta(); load(); }
    if (t.id === "sDefault") { await api("/api/settings", { defaultRevenueColumn: t.value }); await refreshMeta(); load(); }
  } catch (err) { alert(err.message); }
});
