// Статистика, експорт в Excel и състояние на връзката с базата
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const zlib = require("node:zlib");
const { startServer, ROOT } = require("./helpers");
const { comparePeriods, addMonths } = require("../src/stats");

let srv, api;
before(async () => {
  srv = await startServer({ env: { MOCK: "1" }, files: { "data-demo.json": path.join(ROOT, "data-demo.json") } });
  api = srv.request;
});
after(() => srv?.stop());

const r2 = (n) => Math.round(n * 100) / 100;

test("сравними периоди: месец, година, произволен период; краят на месеца се ограничава", () => {
  assert.equal(addMonths("2026-03-31", -1), "2026-02-28");
  assert.equal(addMonths("2024-03-31", -1), "2024-02-29");
  const m = comparePeriods("2026-09-01", "2026-09-30");
  assert.deepEqual(m.prev, { from: "2026-08-01", to: "2026-08-31" });
  assert.deepEqual(m.lastYear, { from: "2025-09-01", to: "2025-09-30" });
  const q = comparePeriods("2026-04-01", "2026-06-30");
  assert.deepEqual(q.prev, { from: "2026-01-01", to: "2026-03-31" });
  const r = comparePeriods("2026-09-10", "2026-09-16");
  assert.deepEqual(r.prev, { from: "2026-09-03", to: "2026-09-09" });
});

test("статистика за месец: суми, серии по дни, дни от седмицата, най-продавани, магазини", async () => {
  const s = (await api("GET", "/api/stats?from=2026-10-01&to=2026-10-31&store=s1")).json;
  const rep = (await api("GET", "/api/report?from=2026-10-01&to=2026-10-31&store=s1")).json;
  const revenue = r2(rep.days.reduce((a, d) => a + Object.values(d.revenue).reduce((x, y) => x + y, 0), 0));
  assert.equal(s.current.revenue, revenue);
  assert.equal(s.byDay, true);
  assert.equal(s.series.length, 31);
  assert.equal(r2(s.series.reduce((a, x) => a + x.revenue, 0)), revenue);
  assert.equal(s.current.profit, r2(s.current.revenue - s.current.expenses));
  assert.deepEqual(s.weekdays.map((w) => w.weekday), [1, 2, 3, 4, 5, 6, 0]);
  assert.equal(s.weekdays.reduce((a, w) => a + w.days, 0), 31);
  assert.ok(s.topItems.length > 0 && s.topItems.every((t, i, a) => i === 0 || a[i - 1].amount >= t.amount));
  assert.ok(s.topItems.every((t) => ["service", "prima", "phones", "goods"].includes(t.col)));
  assert.deepEqual(s.stores.map((x) => x.id), ["s1", "s2"]);
  assert.equal(s.prev.from, "2026-09-01");
});

test("статистика за година е по месеци; „Всички“ е сборът на магазините", async () => {
  const all = (await api("GET", "/api/stats?from=2026-01-01&to=2026-12-31&store=all")).json;
  assert.equal(all.byDay, false);
  assert.equal(all.series.length, 12);
  assert.equal(all.current.revenue, r2(all.stores.reduce((a, x) => a + x.revenue, 0)));
});

test("невалиден период се отказва", async () => {
  assert.equal((await api("GET", "/api/stats?from=2026-10-31&to=2026-10-01")).status, 400);
  assert.equal((await api("GET", "/api/export.xlsx?from=x&to=y")).status, 400);
});

// Чете файловете от zip архив (централната директория)
function unzip(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const files = {};
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20), nameLen = buf.readUInt16LE(p + 28);
    const extra = buf.readUInt16LE(p + 30), comment = buf.readUInt16LE(p + 32), local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    files[name] = (method === 8 ? zlib.inflateRawSync(data) : data).toString("utf8");
    p += 46 + nameLen + extra + comment;
  }
  return files;
}

test("Excel: валиден файл с листове, числа като числа и име на кирилица", async () => {
  const res = await fetch(srv.url + "/api/export.xlsx?from=2026-10-01&to=2026-10-31&store=s1");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /spreadsheetml/);
  assert.match(res.headers.get("content-disposition"), /filename\*=UTF-8''%D0%9E%D1%82%D1%87%D0%B5%D1%82_/);
  const files = unzip(Buffer.from(await res.arrayBuffer()));
  for (const f of ["[Content_Types].xml", "xl/workbook.xml", "xl/styles.xml", "xl/worksheets/sheet1.xml", "xl/worksheets/sheet4.xml"]) assert.ok(files[f], f);
  assert.match(files["xl/workbook.xml"], /name="Обобщение".*name="Приходи".*name="Разходи".*name="Разни"/s);
  const rev = files["xl/worksheets/sheet2.xml"];
  assert.match(rev, /<t xml:space="preserve">Сервиз<\/t>/);
  assert.match(rev, /<c r="B2" s="2"><v>[\d.]+<\/v><\/c>/); // сумите са числа с формат за пари
  const rows = rev.match(/<row /g).length;
  assert.equal(rows, 1 + 31 + 1); // заглавие + дни + общо
});

test("демо режим: състоянието на базата е „демо“", async () => {
  const st = (await api("GET", "/api/state")).json;
  assert.deepEqual(st.db, { mock: true });
});

test("без настроена база: връзката е прекъсната, с „от кога“, записано веднъж в историята", async () => {
  const real = await startServer({ files: { "data.json": path.join(ROOT, "data-demo.json") } });
  try {
    const a = real.request;
    await a("POST", "/api/setup", { username: "admin", password: "secret123" });
    await a("GET", "/api/report?from=2026-11-01&to=2026-11-02");
    const db = (await a("GET", "/api/state")).json.db;
    assert.equal(db.ok, false);
    assert.equal(db.configured, false);
    assert.match(db.error, /не е настроена/);
    assert.ok(Date.parse(db.since) > 0);
    const check = (await a("POST", "/api/db-check", {})).json.db;
    assert.equal(check.ok, false);
    assert.equal(check.since, db.since); // същото прекъсване, не ново
    const h = (await a("GET", "/api/history?from=2020-01-01&to=2035-12-31&kind=sync")).json.entries.filter((e) => e.what === "connection");
    assert.equal(h.length, 1);
  } finally { await real.stop(); }
});

test("сравнение на месец до днес: същият брой дни от предишния месец", () => {
  const t = new Date(), pad = (n) => String(n).padStart(2, "0");
  const ym = `${t.getFullYear()}-${pad(t.getMonth() + 1)}`, today = `${ym}-${pad(t.getDate())}`;
  const last = new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate();
  const c = comparePeriods(`${ym}-01`, `${ym}-${last}`);
  assert.equal(c.current.to, today);
  assert.equal(c.prev.from, addMonths(`${ym}-01`, -1));
  assert.equal(c.prev.to.slice(8), today === `${ym}-${last}` ? c.prev.to.slice(8) : pad(Math.min(t.getDate(), new Date(t.getFullYear(), t.getMonth(), 0).getDate())));
});
