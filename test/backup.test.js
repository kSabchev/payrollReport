// Резервни копия и запис на грешките от базата — в нормален режим, без настроена база
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { startServer, ROOT } = require("./helpers");

const pad = (n) => String(n).padStart(2, "0");
const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return fmt(d); };

// Час „ЧЧ:ММ“, отместен с minutes от сега, и името на копието, което сървърът трябва да направи за него
function timeFromNow(minutes) {
  const t = new Date(Date.now() + minutes * 60000);
  return `${pad(t.getHours())}:${pad(t.getMinutes())}`;
}
function slotFile(time) {
  const [h, m] = time.split(":").map(Number), now = new Date();
  const slot = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m);
  if (slot > now) slot.setDate(slot.getDate() - 1);
  return `data-${fmt(slot)}.json`;
}
const PASSED = timeFromNow(-2); // часът за копие вече е минал днес

let srv, api;
before(async () => {
  srv = await startServer({
    env: { BACKUP_TIME: PASSED, BACKUP_COPY_DIR: "nas" }, // относителен път: спрямо папката с данните
    files: {
      "data.json": path.join(ROOT, "data-demo.json"),
      [`backups/data-${daysAgo(400)}.json`]: "{}", // старите копия не се трият
      [`backups/data-${daysAgo(5)}.json`]: "{}",
    },
    // data.json не е променян от 10 дни: копието пак трябва да е с днешна дата
    // с продажби в кеша, които не трябва да влизат в копието
    prepare: (dir) => {
      const file = path.join(dir, "data.json"), d = JSON.parse(fs.readFileSync(file, "utf8"));
      d.cache = { "2026-11-01": { byObject: { 1: { 1: 100 } }, fetchedAt: "2026-11-02T00:00:00Z" } };
      fs.writeFileSync(file, JSON.stringify(d));
      const old = new Date(Date.now() - 10 * 864e5); fs.utimesSync(file, old, old);
    },
  });
  api = srv.request;
  await api("POST", "/api/setup", { username: "admin", password: "secret123" });
});
after(() => srv?.stop());

const backups = () => fs.readdirSync(path.join(srv.dir, "backups")).sort();

test("часът за копие е минал: при стартиране се прави копието за деня; старите не се трият", () => {
  const files = backups();
  assert.ok(files.includes(slotFile(PASSED)), files.join(", "));
  assert.ok(files.includes(`data-${daysAgo(5)}.json`));
  assert.ok(files.includes(`data-${daysAgo(400)}.json`));
  // копието е съдържанието на data.json отпреди стартирането, без продажбите
  const copy = JSON.parse(fs.readFileSync(path.join(srv.dir, "backups", slotFile(PASSED)), "utf8"));
  const { cache, ...demo } = JSON.parse(fs.readFileSync(path.join(ROOT, "data-demo.json"), "utf8"));
  assert.equal(copy.cache, undefined);
  assert.deepEqual(copy, demo);
});

test("втора папка: старите копия и копието за деня се записват и там", () => {
  const nas = fs.readdirSync(path.join(srv.dir, "nas")).sort();
  assert.deepEqual(nas, backups());
  assert.equal(fs.readFileSync(path.join(srv.dir, "nas", slotFile(PASSED)), "utf8"), fs.readFileSync(path.join(srv.dir, "backups", slotFile(PASSED)), "utf8"));
});

test("ръчно копие от Настройки", async () => {
  const r = await api("POST", "/api/backup", {});
  assert.equal(r.status, 200);
  assert.match(r.json.backup.file, /-manual\.json$/);
  assert.ok(backups().includes(r.json.backup.file));
  assert.ok(fs.readdirSync(path.join(srv.dir, "nas")).includes(r.json.backup.file));
  assert.equal(r.json.backup.copy.dir, path.join(srv.dir, "nas"));
  assert.equal(r.json.backup.copy.error, null);
  const st = (await api("GET", "/api/state")).json.backup;
  assert.equal(st.file, r.json.backup.file);
  assert.equal(st.time, PASSED);
  assert.equal(st.count, 4); // 2 стари + за деня + ръчното
});

test("без настроена база: отчетът връща грешка, а историята я записва", async () => {
  const r = await api("GET", "/api/report?from=2026-11-01&to=2026-11-02");
  assert.equal(r.status, 200);
  assert.match(r.json.syncError, /не е настроена/);
  const h = (await api("GET", `/api/history?from=${daysAgo(1)}&to=${daysAgo(-1)}&kind=sync`)).json.entries;
  assert.ok(h.some((e) => e.error && /не е настроена/.test(e.error)));
});

test("времето на копието е сега, дори data.json да е стар; няма проблем", async () => {
  const b = (await api("GET", "/api/state")).json.backup;
  assert.equal(b.problem, null);
  assert.ok(Date.now() - Date.parse(b.at) < 60_000, b.at);
  const st = fs.statSync(path.join(srv.dir, "backups", slotFile(PASSED)));
  assert.ok(Date.now() - st.mtimeMs < 60_000);
});

test("ако копието не може да се направи: проблем в състоянието и отчета, запис в историята", async () => {
  // "backups" е файл, а не папка — копирането се проваля
  const bad = await startServer({ files: { "data.json": path.join(ROOT, "data-demo.json"), backups: "не е папка" } });
  try {
    const a = bad.request;
    await a("POST", "/api/setup", { username: "admin", password: "secret123" });
    const st = (await a("GET", "/api/state")).json.backup;
    assert.equal(st.problem.kind, "error");
    assert.ok(st.problem.message);
    const rep = (await a("GET", "/api/report?from=2026-11-01&to=2026-11-01")).json;
    assert.equal(rep.backup.problem.kind, "error");
    const manual = await a("POST", "/api/backup", {});
    assert.equal(manual.status, 400);
    assert.match(manual.json.error, /не е направено/);
    const h = (await a("GET", `/api/history?from=${daysAgo(1)}&to=${daysAgo(-1)}&kind=change`)).json.entries;
    assert.equal(h.filter((e) => e.action === "backup-failed").length, 1); // веднъж, не при всеки опит
  } finally { await bad.stop(); }
});

test("часът за копие още не е дошъл: при стартиране се прави пропуснатото копие от вчера, не за днес", async () => {
  const time = timeFromNow(30);
  const s2 = await startServer({ env: { BACKUP_TIME: time }, files: { "data.json": path.join(ROOT, "data-demo.json") } });
  try {
    const files = fs.readdirSync(path.join(s2.dir, "backups"));
    assert.deepEqual(files, [slotFile(time)]); // вчерашното (или днешното след 23:30 — тогава часът е утре)
  } finally { await s2.stop(); }
});

test("копие за деня, което вече съществува, не се презаписва", async () => {
  const s3 = await startServer({ env: { BACKUP_TIME: PASSED }, files: { "data.json": path.join(ROOT, "data-demo.json"), [`backups/${slotFile(PASSED)}`]: "старо" } });
  try {
    assert.equal(fs.readFileSync(path.join(s3.dir, "backups", slotFile(PASSED)), "utf8"), "старо");
  } finally { await s3.stop(); }
});

test("втората папка не е достъпна: основното копие се прави, проблемът се показва и се записва веднъж", async () => {
  const s4 = await startServer({ env: { BACKUP_TIME: PASSED, BACKUP_COPY_DIR: "nas" },
    files: { "data.json": path.join(ROOT, "data-demo.json"), nas: "не е папка" } });
  try {
    const a = s4.request;
    await a("POST", "/api/setup", { username: "admin", password: "secret123" });
    assert.ok(fs.readdirSync(path.join(s4.dir, "backups")).includes(slotFile(PASSED)));
    const st = (await a("GET", "/api/state")).json.backup;
    assert.equal(st.problem.kind, "copy-error");
    assert.ok(st.copy.error);
    const manual = await a("POST", "/api/backup", {});
    assert.equal(manual.status, 200); // основното копие е направено
    assert.equal(manual.json.backup.problem.kind, "copy-error");
    const h = (await a("GET", `/api/history?from=${daysAgo(1)}&to=${daysAgo(-1)}&kind=change`)).json.entries;
    assert.equal(h.filter((e) => e.action === "backup-copy-failed").length, 1);
    assert.equal(h.filter((e) => e.action === "backup-failed").length, 0);
  } finally { await s4.stop(); }
});
