// Настройки: колони, групи, общи настройки, магазини, кеш, ръчно резервно копие
const { MOCK } = require("../config");
const { num, slug, showVal } = require("../util");
const { data, saveData, emptyStore } = require("../data");
const { audit } = require("../history");
const { backup, backupFailed, backupStatus, friendlyFsError } = require("../backup");
const { catalog } = require("../microinvest");
const { sd, storeParam, storesView, ensureFloat, recomputeFloat, floatsAll } = require("../stores");

const tableName = (t) => (t === "revenue" ? "Приходи" : "Разходи");

module.exports = {
  "POST /api/columns": async (_, b, user) => {
    const list = b.table === "revenue" ? data.revenueColumns : b.table === "expense" ? data.expenseColumns : null;
    if (!list) throw new Error("Невалидна таблица");
    const name = String(b.name || "").trim(), where = tableName(b.table);
    let text;
    if (b.action === "add") {
      if (!name) throw new Error("Въведете име на колоната");
      const col = { id: slug(name, list), name };
      if (b.table === "expense" && b.kind === "list") col.kind = "list";
      list.push(col);
      text = `Нова колона в ${where}: „${name}“`;
    } else if (b.action === "rename") {
      const c = list.find((x) => x.id === b.id);
      if (!c || !name) throw new Error("Невалидни данни");
      if (c.name !== name) text = `Преименувана колона в ${where}: „${c.name}“ → „${name}“`;
      c.name = name;
    } else if (b.action === "delete") {
      const i = list.findIndex((x) => x.id === b.id);
      if (i < 0) throw new Error("Няма такава колона");
      if (b.table === "revenue" && data.settings.defaultRevenueColumn === b.id) throw new Error("Това е колоната по подразбиране за продажбите. Изберете друга в Настройки, преди да я изтриете.");
      text = `Изтрита колона в ${where}: „${list[i].name}“`;
      list.splice(i, 1);
      if (b.table === "revenue") for (const g in data.groupMap) if (data.groupMap[g] === b.id) delete data.groupMap[g];
    } else if (b.action === "move") {
      const i = list.findIndex((x) => x.id === b.id), j = i + (b.dir < 0 ? -1 : 1);
      if (i >= 0 && j >= 0 && j < list.length) {
        [list[i], list[j]] = [list[j], list[i]];
        text = `Преместена колона в ${where}: „${list[j].name}“ ${b.dir < 0 ? "наляво" : "надясно"}`;
      }
    } else throw new Error("Невалидно действие");
    if (b.table === "expense") for (const st of data.stores) recomputeFloat(st);
    saveData();
    if (text) audit(user, "columns", text, { table: b.table, op: b.action, id: b.id });
    return { ok: true };
  },

  "POST /api/groupmap": async (_, b, user) => {
    const before = data.groupMap[b.groupId] ?? null;
    if (b.col) data.groupMap[b.groupId] = b.col; else delete data.groupMap[b.groupId];
    saveData();
    if (before !== (b.col || null)) {
      const g = catalog.groups.find((x) => String(x.id) === String(b.groupId));
      const colName = (id) => (id ? data.revenueColumns.find((c) => c.id === id)?.name ?? id : "автоматично");
      audit(user, "groupmap", `Група „${g ? `${g.name} ${g.code}` : b.groupId}“: ${colName(before)} → ${colName(b.col)}`,
        { groupId: b.groupId, before, after: b.col || null });
    }
    return { ok: true };
  },

  "POST /api/settings": async (_, b, user) => {
    const s = data.settings, changes = [];
    if (b.withVat !== undefined && !!b.withVat !== s.withVat) {
      s.withVat = !!b.withVat; data.cache = {};
      changes.push(s.withVat ? "суми с ДДС" : "суми без ДДС");
    }
    if (b.operationTypes !== undefined) {
      const t = String(b.operationTypes).split(/[ ,;]+/).map(Number).filter((n) => Number.isInteger(n) && n > 0);
      if (!t.length) throw new Error("Въведете поне един тип операция");
      if (t.join() !== s.operationTypes.join()) { changes.push(`типове операции ${s.operationTypes.join(", ")} → ${t.join(", ")}`); data.cache = {}; }
      s.operationTypes = t;
    }
    if (b.defaultRevenueColumn !== undefined && b.defaultRevenueColumn !== s.defaultRevenueColumn) {
      const colName = (id) => data.revenueColumns.find((c) => c.id === id)?.name ?? id;
      changes.push(`колона по подразбиране „${colName(s.defaultRevenueColumn)}“ → „${colName(b.defaultRevenueColumn)}“`);
      s.defaultRevenueColumn = b.defaultRevenueColumn;
    }
    saveData();
    if (changes.length) audit(user, "settings", "Настройки: " + changes.join("; "));
    return { ok: true };
  },

  "POST /api/clear-cache": async (_, __, user) => {
    data.cache = {}; catalog.loadedAt = 0; saveData();
    audit(user, "cache", "Изтрити запазените продажби, ще се изтеглят наново от Microinvest");
    return { ok: true };
  },

  // Магазини: добавяне, промяна (име, обект, оборотни пари по подразбиране), изтриване
  "POST /api/stores": async (_, b, user) => {
    const objName = (id) => (id == null ? "всички обекти" : catalog.objects.find((o) => o.id === id)?.name ?? `обект ${id}`);
    const parseObj = (v) => {
      if (v === "" || v === null || v === undefined) return null;
      const n = Number(v);
      if (!Number.isInteger(n)) throw new Error("Обектът трябва да е число (ID в Microinvest)");
      return n;
    };
    // При няколко магазина всеки трябва да е точно един обект, иначе сборът „Всички“ брои продажбите два пъти
    const validate = (stores) => {
      if (stores.length > 1 && stores.some((x) => x.objectId == null))
        throw new Error("При няколко магазина всеки трябва да има избран обект от Microinvest");
      const ids = stores.map((x) => x.objectId).filter((x) => x != null);
      if (new Set(ids).size !== ids.length) throw new Error("Два магазина не може да са един и същ обект");
    };
    let text;
    if (b.action === "add") {
      const name = String(b.name || "").trim();
      if (!name) throw new Error("Въведете име на магазина");
      const floatDefault = num(b.floatDefault ?? 8500);
      if (floatDefault === null || floatDefault < 0) throw new Error("Невалидна сума на оборотните пари");
      const st = { id: slug(name, data.stores).replace(/^c/, "s"), name, objectId: parseObj(b.objectId), floatDefault };
      validate([...data.stores, st]);
      data.stores.push(st);
      data.byStore[st.id] = emptyStore();
      ensureFloat(st); recomputeFloat(st);
      text = `Нов магазин „${name}“ (${objName(st.objectId)}, оборотни ${showVal(floatDefault)})`;
    } else if (b.action === "update") {
      const st = storeParam(b.id), next = { ...st }, changes = [];
      if (b.name !== undefined) {
        next.name = String(b.name).trim();
        if (!next.name) throw new Error("Въведете име на магазина");
        if (next.name !== st.name) changes.push(`име „${st.name}“ → „${next.name}“`);
      }
      if (b.objectId !== undefined) {
        next.objectId = parseObj(b.objectId);
        if (next.objectId !== st.objectId) changes.push(`обект ${objName(st.objectId)} → ${objName(next.objectId)}`);
      }
      if (b.floatDefault !== undefined) {
        next.floatDefault = num(b.floatDefault);
        if (next.floatDefault === null || next.floatDefault < 0) throw new Error("Невалидна сума на оборотните пари");
        if (next.floatDefault !== st.floatDefault) changes.push(`оборотни по подразбиране ${showVal(st.floatDefault)} → ${showVal(next.floatDefault)}`);
      }
      validate(data.stores.map((x) => (x === st ? next : x)));
      Object.assign(st, next);
      if (changes.length) text = `Магазин „${st.name}“: ${changes.join("; ")}`;
    } else if (b.action === "delete") {
      const st = storeParam(b.id);
      if (data.stores.length === 1) throw new Error("Трябва да има поне един магазин");
      const d = sd(st);
      if (Object.keys(d.expenses).length || Object.keys(d.revenueManual).length)
        throw new Error(`Магазинът „${st.name}“ има въведени разходи или ръчни приходи и не може да се изтрие`);
      data.stores = data.stores.filter((x) => x !== st);
      delete data.byStore[st.id];
      text = `Изтрит магазин „${st.name}“`;
    } else throw new Error("Невалидно действие");
    saveData();
    if (text) audit(user, "stores", text, { op: b.action, id: b.id });
    return { ok: true, stores: storesView(), floats: floatsAll() };
  },

  "POST /api/backup": async (_, __, user) => {
    if (MOCK) throw new Error("В демо режим не се правят резервни копия");
    let file;
    try { file = backup("manual"); } catch (e) { backupFailed(e); throw new Error("Копието не е направено: " + friendlyFsError(e)); }
    audit(user, "backup", `Ръчно резервно копие: ${file}`);
    return { ok: true, backup: backupStatus() };
  },
};
