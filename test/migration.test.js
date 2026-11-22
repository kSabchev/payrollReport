// Данни от версия 1 (един магазин) се преобразуват при стартиране, с копие на стария файл
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { startServer } = require("./helpers");

const V1 = path.join(__dirname, "fixtures", "data-v1.json");
const old = JSON.parse(fs.readFileSync(V1, "utf8"));

let srv, api;
before(async () => {
  // Старият вид, с избран обект и оборотни пари в настройките
  const v1 = { ...old, settings: { ...old.settings, objectId: 7, floatDefault: 9100 } };
  srv = await startServer({ files: { "data.json": v1 } });
  api = srv.request;
  await api("POST", "/api/setup", { username: "admin", password: "secret123" });
});
after(() => srv?.stop());

test("файлът е в новия вид, разходите и оборотните пари са в първия магазин", () => {
  const d = srv.readJson("data.json");
  assert.equal(d.dataVersion, 2);
  assert.deepEqual(d.stores, [{ id: "s1", name: "Магазин", objectId: 7, floatDefault: 9100 }]);
  assert.deepEqual(d.byStore.s1.expenses, old.expenses);
  assert.deepEqual(d.byStore.s1.float, old.float);
  for (const k of ["expenses", "revenueManual", "float", "floatBalance"]) assert.equal(d[k], undefined, k);
  assert.equal(d.settings.objectId, undefined);
  assert.equal(d.settings.floatDefault, undefined);
});

test("преди преобразуването е направено копие на стария файл", () => {
  const files = fs.readdirSync(path.join(srv.dir, "backups"));
  const copy = files.find((f) => f.endsWith("-before-stores.json"));
  assert.ok(copy, files.join(", "));
  const d = JSON.parse(fs.readFileSync(path.join(srv.dir, "backups", copy), "utf8"));
  assert.equal(d.dataVersion, undefined);
  assert.deepEqual(d.expenses, old.expenses);
});

test("отчетът показва старите разходи", async () => {
  const day = Object.keys(old.expenses).find((d) => d.startsWith("2026-10"));
  const r = await api("GET", `/api/report?from=${day}&to=${day}`);
  assert.deepEqual(r.json.days[0].expenses, old.expenses[day]);
});

test("преобразуването е записано в историята", async () => {
  const h = (await api("GET", "/api/history?from=2020-01-01&to=2035-12-31&kind=change")).json.entries;
  assert.ok(h.some((e) => e.action === "migration"));
});
