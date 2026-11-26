// Четене: състояние на програмата, отчет по дни, продажби за ден, история
const { MOCK, AUTH } = require("../config");
const { isDate, round2 } = require("../util");
const { data } = require("../data");
const { readHistory } = require("../history");
const { backupStatus } = require("../backup");
const { usersList } = require("../auth");
const { connectionInfo, source, fromDb, catalog, loadCatalog, columnForGroup, mappedColumns, syncRange } = require("../microinvest");
const { storeParam, objectIdsOf, storesView, refreshFloat, floatsAll, buildReport } = require("../stores");

module.exports = {
  "GET /api/state": async (_, __, user) => {
    refreshFloat();
    let groups = catalog.groups, catalogError = null;
    try { groups = (await loadCatalog(false, user)).groups; } catch (e) { catalogError = e.message; }
    return { settings: data.settings, connection: connectionInfo(), revenueColumns: data.revenueColumns, expenseColumns: data.expenseColumns,
      groupMap: data.groupMap, groups, mappedColumns: mappedColumns(), catalogError, mock: MOCK,
      stores: storesView(), objects: catalog.objects, objectsError: catalog.objectsError,
      isAdmin: true, // до приложението стигат само администратори
      auth: { enabled: AUTH, user: user && { name: user.name }, users: AUTH ? usersList() : [] },
      backup: backupStatus(), floats: floatsAll() };
  },

  "GET /api/report": async (q, _, user) => {
    const from = q.get("from"), to = q.get("to"), sel = storeParam(q.get("store"), true);
    if (!isDate(from) || !isDate(to) || from > to) throw new Error("Невалиден период");
    let syncError = null;
    try { await syncRange(from, to, q.get("force") === "1", user); } catch (e) { syncError = e.message; }
    refreshFloat();
    return { days: buildReport(from, to, sel), syncError, mappedColumns: mappedColumns(), floats: floatsAll(), backup: backupStatus() };
  },

  // Продажбите от Microinvest за един ден и една колона — за проверка
  "GET /api/detail": async (q, _, user) => {
    const date = q.get("date"), col = q.get("col"), sel = storeParam(q.get("store"), true);
    if (!isDate(date)) throw new Error("Невалидна дата");
    await loadCatalog(false, user);
    const lines = await fromDb("detail", user, { trigger: "manual", from: date, to: date }, async () => {
      const r = await source.saleLines(date, objectIdsOf(sel));
      return [r, { rows: r.length }];
    });
    const byItem = new Map();
    for (const r of lines) {
      if (columnForGroup(String(r.groupId ?? "none")) !== col) continue;
      const key = String(r.goodId);
      const row = byItem.get(key) || { name: r.name ?? `Артикул ${key}`, code: r.code ?? "", qtty: 0, amount: 0, docs: new Set() };
      row.qtty += Number(r.qtty || 0);
      row.amount += Number(r.amount || 0);
      if (r.doc != null) row.docs.add(r.doc);
      byItem.set(key, row);
    }
    return { lines: [...byItem.values()].map((r) => ({ ...r, qtty: round2(r.qtty), amount: round2(r.amount), docs: [...r.docs] }))
      .sort((a, b) => b.amount - a.amount) };
  },

  "GET /api/history": async (q) => {
    const from = q.get("from"), to = q.get("to"), kind = q.get("kind");
    if (!isDate(from) || !isDate(to) || from > to) throw new Error("Невалиден период");
    return readHistory(from, to, kind === "change" || kind === "sync" ? kind : null);
  },
};
