// Няколко магазина: отделни разходи и оборотни пари, сбор „Всички“, управление на магазините
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

const report = async (store, from = "2026-10-01", to = "2026-10-31") => (await api("GET", `/api/report?from=${from}&to=${to}&store=${store}`)).json;
const r2 = (n) => Math.round(n * 100) / 100;
const total = (days, f) => r2(days.reduce((s, d) => s + f(d), 0));
const expSum = (d) => Object.values(d.expenses).reduce((s, v) => s + (Array.isArray(v) ? v.reduce((a, i) => a + i.value, 0) : v), 0);

test("демото има два магазина с обектите от Microinvest", async () => {
  const st = (await api("GET", "/api/state")).json;
  assert.deepEqual(st.stores.map((s) => [s.id, s.name, s.objectId, s.floatDefault]),
    [["s1", "Магазин Център", 1, 8500], ["s2", "Магазин Мол", 2, 5000]]);
  assert.deepEqual(st.objects.map((o) => o.id), [1, 2]);
  assert.deepEqual(Object.keys(st.floats), ["s1", "s2"]);
});

test("продажбите са по обекти, а „Всички“ е сборът", async () => {
  const [a, b, all] = [await report("s1"), await report("s2"), await report("all")];
  for (const col of ["service", "prima", "phones", "goods"]) {
    const sa = total(a.days, (d) => d.revenueApi[col]), sb = total(b.days, (d) => d.revenueApi[col]);
    assert.equal(total(all.days, (d) => d.revenueApi[col]), r2(sa + sb), col);
  }
  assert.notEqual(total(a.days, (d) => d.revenueApi.goods), total(b.days, (d) => d.revenueApi.goods));
  assert.ok(all.days.every((d) => d.readonly));
});

test("разходите и остатъкът са отделни за всеки магазин; „Всички“ ги сумира", async () => {
  const date = "2026-10-15";
  const before1 = (await report("s1", date, date)).days[0];
  await api("POST", "/api/expense", { store: "s2", date, col: "bills", value: 77 });
  const [a, b, all] = [(await report("s1", date, date)).days[0], (await report("s2", date, date)).days[0], (await report("all", date, date)).days[0]];
  assert.deepEqual(a.expenses, before1.expenses);
  assert.equal(a.balance, before1.balance);
  assert.equal(b.expenses.bills, 77);
  assert.equal(r2(expSum(all)), r2(expSum(a) + expSum(b)));
  assert.equal(all.balance, r2(a.balance + b.balance));
  // вторият магазин започва месеца със своите 5000
  const first = (await report("s2", "2026-10-01", "2026-10-01")).days[0];
  assert.equal(first.balance, r2(5000 - expSum(first)));
});

test("в „Всички“ не може да се записва", async () => {
  assert.equal((await api("POST", "/api/expense", { store: "all", date: "2026-10-15", col: "bills", value: 1 })).status, 400);
  assert.equal((await api("POST", "/api/revenue", { store: "all", date: "2026-10-15", col: "goods", value: 1 })).status, 400);
  assert.equal((await api("POST", "/api/float", { store: "all", action: "set", amount: 1 })).status, 400);
});

test("артикулите за ден са само от обекта на магазина", async () => {
  const date = "2026-10-15";
  const lines = async (store) => (await api("GET", `/api/detail?date=${date}&col=goods&store=${store}`)).json.lines;
  const [a, b, all] = [await lines("s1"), await lines("s2"), await lines("all")];
  const amount = (ls) => r2(ls.reduce((s, l) => s + l.amount, 0));
  assert.equal(amount(all), r2(amount(a) + amount(b)));
  assert.equal(amount(a), (await report("s1", date, date)).days[0].revenueApi.goods);
});

test("оборотните пари се сменят само за избрания магазин", async () => {
  const st = (await api("GET", "/api/state")).json.floats;
  const r = await api("POST", "/api/float", { store: "s2", action: "set", amount: 6000 });
  assert.equal(r.json.floats.s2.current.amount, 6000);
  assert.equal(r.json.floats.s1.current.amount, st.s1.current.amount);
});

test("магазини: проверки при добавяне, промяна и изтриване", async () => {
  const add = (body) => api("POST", "/api/stores", { action: "add", ...body });
  assert.match((await add({ name: "Без обект" })).json.error, /обект/);
  assert.match((await add({ name: "Дубликат", objectId: 2 })).json.error, /един и същ обект/);
  assert.equal((await add({ name: "", objectId: 3 })).status, 400);

  const r = await add({ name: "Склад", objectId: 3, floatDefault: "3000" });
  assert.equal(r.status, 200);
  const st = r.json.stores.find((s) => s.name === "Склад");
  assert.equal(st.floatDefault, 3000);
  assert.equal(r.json.floats[st.id].current.amount, 3000);

  assert.match((await api("POST", "/api/stores", { action: "update", id: st.id, objectId: "" })).json.error, /обект/);
  assert.equal((await api("POST", "/api/stores", { action: "update", id: st.id, name: "Склад 2" })).status, 200);
  assert.match((await api("POST", "/api/stores", { action: "delete", id: "s1" })).json.error, /разходи/);
  assert.equal((await api("POST", "/api/stores", { action: "delete", id: st.id })).status, 200);
  assert.equal((await api("GET", "/api/state")).json.stores.length, 2);

  const h = (await api("GET", "/api/history?from=2026-01-01&to=2030-12-31&kind=change")).json.entries;
  assert.ok(h.some((e) => e.text.startsWith("Нов магазин „Склад“")));
  assert.ok(h.some((e) => e.text.startsWith("Магазин Мол · Разход 15.10.2026")));
});
