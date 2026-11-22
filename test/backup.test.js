// Резервни копия и запис на грешките от базата — в нормален режим, без настроена база
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { startServer, ROOT } = require("./helpers");

const pad = (n) => String(n).padStart(2, "0");
const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return fmt(d); };

let srv, api;
before(async () => {
  srv = await startServer({
    files: {
      "data.json": path.join(ROOT, "data-demo.json"),
      [`backups/data-${daysAgo(40)}.json`]: "{}", // по-старо от 30 дни — трие се
      [`backups/data-${daysAgo(5)}.json`]: "{}",  // остава
    },
  });
  api = srv.request;
  await api("POST", "/api/setup", { username: "admin", password: "secret123" });
});
after(() => srv?.stop());

const backups = () => fs.readdirSync(path.join(srv.dir, "backups")).sort();

test("при стартиране се прави копие за днес и се трият копията по-стари от 30 дни", () => {
  const files = backups();
  assert.ok(files.includes(`data-${fmt(new Date())}.json`));
  assert.ok(files.includes(`data-${daysAgo(5)}.json`));
  assert.ok(!files.includes(`data-${daysAgo(40)}.json`));
  // копието е съдържанието на data.json отпреди стартирането
  const copy = JSON.parse(fs.readFileSync(path.join(srv.dir, "backups", `data-${fmt(new Date())}.json`), "utf8"));
  assert.deepEqual(copy.expenses, JSON.parse(fs.readFileSync(path.join(ROOT, "data-demo.json"), "utf8")).expenses);
});

test("ръчно копие от Настройки", async () => {
  const r = await api("POST", "/api/backup", {});
  assert.equal(r.status, 200);
  assert.match(r.json.backup.file, /-manual\.json$/);
  assert.ok(backups().includes(r.json.backup.file));
  const st = (await api("GET", "/api/state")).json.backup;
  assert.equal(st.file, r.json.backup.file);
  assert.equal(st.keepDays, 30);
});

test("без настроена база: отчетът връща грешка, а историята я записва", async () => {
  const r = await api("GET", "/api/report?from=2026-11-01&to=2026-11-02");
  assert.equal(r.status, 200);
  assert.match(r.json.syncError, /не е настроена/);
  const h = (await api("GET", `/api/history?from=${daysAgo(1)}&to=${daysAgo(-1)}&kind=sync`)).json.entries;
  assert.ok(h.some((e) => e.error && /не е настроена/.test(e.error)));
});
