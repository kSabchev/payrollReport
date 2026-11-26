// Магазини (в Настройки)

// ------------------------------------------------------------ Магазини (Настройки)
function objectLabel(id) {
  if (id == null) return "всички обекти";
  const o = (S.meta.objects || []).find((x) => x.id === id);
  return o ? `${o.name} (${o.id})` : `обект ${id}`;
}

function storesSettings() {
  const err = S.meta.objectsError;
  return `<h3>Магазини</h3>
    <p class="help">Всеки магазин е обект в Microinvest. Разходите, ръчните приходи и оборотните пари са отделни за всеки магазин;
      колоните и групите са общи. Горе вляво се избира магазин или „Всички магазини“ (сбор, само за преглед).</p>
    ${err ? `<p class="err">Списъкът с обекти не се зарежда: ${esc(err)} Дайте права в SQL Server Management Studio:
      <code>GRANT SELECT ON dbo.Objects TO [payroll_report];</code> Дотогава въвеждайте номера (ID) на обекта.</p>` : ""}
    <table class="maptable"><thead><tr><th>Магазин</th><th>Обект в Microinvest</th><th>Оборотни по подразбиране</th><th></th></tr></thead><tbody>
    ${S.meta.stores.map((st) => `<tr><td>${esc(st.name)}</td><td>${esc(objectLabel(st.objectId))}</td><td>${m(st.floatDefault)}</td>
      <td><button class="ghost" data-storeedit="${esc(st.id)}">Промени</button>
        ${multiStore() ? `<button class="ghost" data-storedel="${esc(st.id)}" ${st.hasData ? `disabled title="Има въведени разходи или ръчни приходи"` : ""}>Изтрий</button>` : ""}</td></tr>`).join("")}
    </tbody></table>
    <div class="actions" style="justify-content:flex-start;margin-top:8px"><button class="ghost" id="addStore">+ Нов магазин</button></div>`;
}

// Без id — нов магазин
function openStore(id) {
  const st = id ? S.meta.stores.find((x) => x.id === id) : null;
  const objects = S.meta.objects || [];
  // „Всички обекти“ има смисъл само при един магазин
  const allowAll = !st ? false : S.meta.stores.length === 1;
  const objField = objects.length
    ? `<select class="field" id="stObj">${allowAll ? `<option value="">— всички обекти —</option>` : `<option value="">— изберете —</option>`}
        ${objects.map((o) => `<option value="${o.id}" ${st?.objectId === o.id ? "selected" : ""}>${esc(o.name)} (${o.id})</option>`).join("")}</select>`
    : `<input class="field" id="stObj" inputmode="numeric" placeholder="ID на обекта${allowAll ? " (празно = всички)" : ""}" value="${st?.objectId ?? ""}">`;
  const needsObj = !st && S.meta.stores.some((x) => x.objectId == null);
  showDialog(`<h2>${st ? `Магазин „${esc(st.name)}“` : "Нов магазин"}</h2>
    ${needsObj ? `<p class="sub">Първо изберете обект за „${esc(S.meta.stores.find((x) => x.objectId == null).name)}“, после добавете нов магазин.</p>` : ""}
    <div class="form" style="grid-template-columns:150px 1fr;margin-top:10px">
      <label for="stName">Име</label><input class="field" id="stName" value="${esc(st?.name ?? "")}">
      <label for="stObj">Обект в Microinvest</label>${objField}
      <label for="stFloat">Оборотни пари</label><input class="field amount" id="stFloat" inputmode="decimal" value="${m(st?.floatDefault ?? 8500)}">
    </div>
    <p class="muted" style="margin:8px 0 0">Оборотните пари тук са сумата, предлагана при нулиране всеки месец.
      Сумата за текущия месец се сменя с „Промени“ горе.</p>
    <div class="actions"><button class="ghost" id="cancel">Отказ</button><button class="primary" id="ok">${st ? "Запази" : "Добави"}</button></div>`, (root) => {
    $("#cancel", root).onclick = closeDialog;
    $("#ok", root).onclick = async () => {
      const floatDefault = toNum($("#stFloat", root).value);
      if (floatDefault === null || Number.isNaN(floatDefault)) return alert("Въведете сума на оборотните пари");
      const body = { name: $("#stName", root).value, objectId: $("#stObj", root).value, floatDefault };
      try {
        await api("/api/stores", st ? { action: "update", id: st.id, ...body } : { action: "add", ...body });
        closeDialog(); await refreshMeta(); fixStore(); load();
      } catch (err) { alert(err.message); }
    };
  });
  setTimeout(() => $("#stName")?.focus(), 0);
}
