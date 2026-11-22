// Отчет, разходи, оборотни пари, колони, групи и история — в демо режим (без база)
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { startServer, ROOT } = require("./helpers");

let srv, api;
before(async () => {
  srv = await startServer({ env: { MOCK: "1" }, files: { "data-demo.json": path.join(ROOT, "data-demo.json") } });
  api = srv.request;
});
after(() => srv?.stop());

const report = async (from, to) => (await api("GET", `/api/report?from=${from}&to=${to}`)).json;
const sum = (days, f) => Math.round(days.reduce((s, d) => s + f(d), 0) * 100) / 100;

test("state: демо режим без вход", async () => {
  const r = await api("GET", "/api/state");
  assert.equal(r.status, 200);
  assert.equal(r.json.mock, true);
  assert.equal(r.json.auth.enabled, false);
  assert.deepEqual(r.json.revenueColumns.map((c) => c.id), ["service", "prima", "phones", "goods"]);
});

test("страницата се отваря", async () => {
  const r = await api("GET", "/");
  assert.equal(r.status, 200);
  assert.match(r.text, /<title>Отчет<\/title>/);
});

test("отчет за месец: всеки ден, приходи от демо продажбите, разходи от файла", async () => {
  const r = await report("2026-10-01", "2026-10-31");
  assert.equal(r.days.length, 31);
  assert.equal(r.syncError, null);
  assert.ok(sum(r.days, (d) => Object.values(d.revenue).reduce((a, b) => a + b, 0)) > 0);
  const file = srv.readJson("data-demo.json");
  const day = Object.keys(file.expenses).find((d) => d.startsWith("2026-10"));
  assert.deepEqual(r.days.find((d) => d.date === day).expenses, file.expenses[day]);
});

test("невалиден период", async () => {
  const r = await api("GET", "/api/report?from=2026-10-31&to=2026-10-01");
  assert.equal(r.status, 400);
});

test("разход: записва се, намалява остатъка и влиза в историята веднъж", async () => {
  const date = "2026-11-03";
  const beforeBal = (await report(date, date)).days[0].balance;
  const r = await api("POST", "/api/expense", { date, col: "fuel", value: "12,50", from: date, to: date });
  assert.equal(r.status, 200);
  assert.equal(r.json.value, 12.5);
  const prev = (await report(date, date)).days[0];
  assert.equal(prev.expenses.fuel, 12.5);
  // остатъкът пада с разликата спрямо предишната стойност
  assert.ok(prev.balance <= beforeBal);

  await api("POST", "/api/expense", { date, col: "fuel", value: "12.5" }); // същата стойност
  const h = (await api("GET", `/api/history?from=2026-01-01&to=2030-12-31&kind=change`)).json.entries
    .filter((e) => e.action === "expense" && e.date === date && e.col === "fuel");
  assert.equal(h.length, 1);
  assert.match(h[0].text, /Гориво: .* → 12,50/);
});

test("разход със списък (Разни)", async () => {
  const date = "2026-11-04";
  const items = [{ name: "Тонер", value: "30" }, { name: "Празен ред", value: "" }, { name: "Хартия", value: 8.4 }];
  const r = await api("POST", "/api/expense", { date, col: "misc", items });
  assert.deepEqual(r.json.value, [{ name: "Тонер", value: 30 }, { name: "Хартия", value: 8.4 }]);
  await api("POST", "/api/expense", { date, col: "misc", items: [] });
  assert.equal((await report(date, date)).days[0].expenses.misc, undefined);
});

test("невалидно число и непозната колона се отказват", async () => {
  assert.equal((await api("POST", "/api/expense", { date: "2026-11-05", col: "fuel", value: "abc" })).status, 400);
  assert.equal((await api("POST", "/api/expense", { date: "2026-11-05", col: "nope", value: 1 })).status, 400);
});

test("POST без JSON се отказва (защита от CSRF)", async () => {
  const r = await api("POST", "/api/expense", JSON.stringify({ date: "2026-11-05", col: "fuel", value: 1 }), { contentType: "text/plain" });
  assert.equal(r.status, 415);
});

test("ръчен приход замества сумата от Microinvest и се маха", async () => {
  const date = "2026-10-10";
  await api("POST", "/api/revenue", { date, col: "goods", value: "999" });
  let d = (await report(date, date)).days[0];
  assert.equal(d.revenue.goods, 999);
  assert.ok(d.edited.includes("goods"));
  await api("POST", "/api/revenue", { date, col: "goods", value: null });
  d = (await report(date, date)).days[0];
  assert.equal(d.revenue.goods, d.revenueApi.goods);
});

test("подгрупите наследяват колоната на основната група", async () => {
  // В демото група 2 (код 002) и подгрупата ѝ 5 (002001) нямат колона и отиват в „Стока“
  const from = "2026-10-01", to = "2026-10-31";
  const r1 = await report(from, to);
  const goods = sum(r1.days, (d) => d.revenueApi.goods), phones = sum(r1.days, (d) => d.revenueApi.phones);
  assert.ok(goods > 0);
  await api("POST", "/api/groupmap", { groupId: "2", col: "phones" });
  const r2 = await report(from, to);
  assert.equal(sum(r2.days, (d) => d.revenueApi.goods), 0);
  assert.equal(sum(r2.days, (d) => d.revenueApi.phones), Math.round((goods + phones) * 100) / 100);
  await api("POST", "/api/groupmap", { groupId: "2", col: null });
});

test("оборотни пари: смяна на сумата преизчислява остатъка", async () => {
  const st = (await api("GET", "/api/state")).json.float;
  assert.ok(st.current);
  const r = await api("POST", "/api/float", { action: "set", amount: st.current.amount + 1000 });
  assert.equal(r.status, 200);
  assert.equal(r.json.float.current.amount, st.current.amount + 1000);
  if (st.balance != null) assert.equal(r.json.float.balance, Math.round((st.balance + 1000) * 100) / 100);
  assert.equal((await api("POST", "/api/float", { action: "set", amount: -5 })).status, 400);
});

test("колони: добавяне, преименуване, изтриване; колоната по подразбиране не се трие", async () => {
  await api("POST", "/api/columns", { table: "expense", action: "add", name: "Наем" });
  let cols = (await api("GET", "/api/state")).json.expenseColumns;
  const col = cols.find((c) => c.name === "Наем");
  assert.ok(col);
  await api("POST", "/api/columns", { table: "expense", action: "rename", id: col.id, name: "Наем офис" });
  await api("POST", "/api/columns", { table: "expense", action: "delete", id: col.id });
  cols = (await api("GET", "/api/state")).json.expenseColumns;
  assert.ok(!cols.some((c) => c.id === col.id));
  const r = await api("POST", "/api/columns", { table: "revenue", action: "delete", id: "goods" });
  assert.equal(r.status, 400);
});

test("история: четенията от базата се записват", async () => {
  const h = (await api("GET", "/api/history?from=2026-01-01&to=2030-12-31&kind=sync")).json.entries;
  assert.ok(h.some((e) => e.what === "sales" && e.rows > 0 && typeof e.ms === "number"));
  assert.ok(h.every((e) => e.kind === "sync"));
});
