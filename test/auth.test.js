// Акаунти и вход (демо режим с DEMO_LOGIN=1)
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { startServer, ROOT } = require("./helpers");

let srv;
before(async () => {
  srv = await startServer({ env: { MOCK: "1", DEMO_LOGIN: "1" }, files: { "data-demo.json": path.join(ROOT, "data-demo.json") } });
});
after(() => srv?.stop());

test("вход, акаунти, заключване и изход", async (t) => {
  const admin = srv.client();

  await t.test("без акаунти: страницата се отваря, данните не", async () => {
    assert.equal((await admin("GET", "/")).status, 200);
    assert.deepEqual((await admin("GET", "/api/session")).json, { auth: true, user: null, setup: true });
    const r = await admin("GET", "/api/state");
    assert.equal(r.status, 401);
    assert.equal(r.json.login, true);
  });

  await t.test("първи акаунт: кратка парола се отказва, после се създава и влиза", async () => {
    assert.match((await admin("POST", "/api/setup", { username: "ivan", password: "123" })).json.error, /8 знака/);
    assert.equal((await admin("POST", "/api/setup", { username: "има интервал", password: "secret123" })).status, 400);
    const r = await admin("POST", "/api/setup", { username: "Ivan", password: "secret123" });
    assert.equal(r.status, 200);
    const cookie = r.headers.get("set-cookie");
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    const st = await admin("GET", "/api/state");
    assert.equal(st.status, 200);
    assert.equal(st.json.auth.user.name, "ivan");
  });

  await t.test("втори първи акаунт не може", async () => {
    const other = srv.client();
    assert.equal((await other("POST", "/api/setup", { username: "x", password: "secret123" })).status, 400);
  });

  await t.test("нов акаунт; дублиране се отказва", async () => {
    assert.equal((await admin("POST", "/api/users", { action: "add", username: "maria", password: "maria1234" })).status, 200);
    assert.equal((await admin("POST", "/api/users", { action: "add", username: "MARIA", password: "maria1234" })).status, 400);
  });

  await t.test("паролите не се пазят като текст", async () => {
    const text = JSON.stringify(srv.readJson("data-demo.json"));
    assert.ok(!text.includes("secret123") && !text.includes("maria1234"));
    const users = srv.readJson("data-demo.json").users;
    assert.deepEqual(users.map((u) => u.username), ["ivan", "maria"]);
    assert.ok(users.every((u) => /^[0-9a-f]{128}$/.test(u.hash) && u.salt));
  });

  await t.test("вход с главни букви в името", async () => {
    const m = srv.client();
    assert.equal((await m("POST", "/api/login", { username: "Maria", password: "maria1234" })).status, 200);
    assert.equal((await m("GET", "/api/state")).status, 200);
  });

  await t.test("5 грешни пароли заключват акаунта", async () => {
    const x = srv.client();
    for (let i = 0; i < 5; i++) assert.match((await x("POST", "/api/login", { username: "maria", password: "wrong" })).json.error, /Грешно/);
    assert.match((await x("POST", "/api/login", { username: "maria", password: "maria1234" })).json.error, /Твърде много/);
  });

  await t.test("смяната на парола изкарва другите устройства", async () => {
    const other = srv.client();
    await other("POST", "/api/login", { username: "ivan", password: "secret123" });
    assert.equal((await other("GET", "/api/state")).status, 200);
    assert.equal((await admin("POST", "/api/users", { action: "password", username: "ivan", password: "newpass123" })).status, 200);
    assert.equal((await other("GET", "/api/state")).status, 401);
    assert.equal((await admin("GET", "/api/state")).status, 200); // текущото устройство остава
  });

  await t.test("собственият акаунт не се трие, друг се трие", async () => {
    assert.equal((await admin("POST", "/api/users", { action: "delete", username: "ivan" })).status, 400);
    const r = await admin("POST", "/api/users", { action: "delete", username: "maria" });
    assert.deepEqual(r.json.users.map((u) => u.username), ["ivan"]);
  });

  await t.test("изход", async () => {
    assert.equal((await admin("POST", "/api/logout", {})).status, 200);
    assert.equal((await admin("GET", "/api/state")).status, 401);
  });

  await t.test("историята пази входовете и промените по акаунтите", async () => {
    const a = srv.client();
    await a("POST", "/api/login", { username: "ivan", password: "newpass123" });
    const h = (await a("GET", "/api/history?from=2026-01-01&to=2030-12-31&kind=change")).json.entries;
    for (const action of ["login", "login-failed", "logout", "users"]) assert.ok(h.some((e) => e.action === action), action);
    assert.ok(h.some((e) => e.text === "Нов акаунт „maria“" && e.user === "ivan"));
  });
});
