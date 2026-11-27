// Импорт на разходи от Excel: файл като истинския (лист за всеки месец, приходи вляво, ред „Sum“)
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { startServer, ROOT } = require("./helpers");
const { workbook, zip } = require("../src/xlsx");

const HEAD = ["Дата", "Приход магазин (общо)", "Приход Стока", "Сервиз", "Телефони", "МъниГрам", "Прими", "Онлине", null,
  "Разход Магазин (общо)", "Разни", "Сервиз", "Стока", "А/Д", "Сметки", "Гориво", "Онлине", "Телефони"];
const EXP = HEAD.slice(10); // K–R

// days: { ден: { заглавие: сума } }; withDayCol = false — без колона A (като листа „Януари“)
function sheet(name, days, { withDayCol = true } = {}) {
  const rows = [HEAD.map((h, i) => (i === 0 && !withDayCol ? null : h))];
  for (let d = 1; d <= 31; d++) {
    const v = days[d] || {};
    const exp = EXP.map((h) => v[h] ?? null);
    const total = exp.reduce((s, x) => s + (x || 0), 0);
    // приходите вляво не трябва да се внасят, дори колоните да се казват като разходите
    rows.push([withDayCol ? d : null, 999, 1, 2, 3, 4, 5, 6, null, total, ...exp]);
  }
  rows.push([withDayCol ? "Sum" : null, 0, 0, 0, 0, 0, 0, 0, null, 12345, ...EXP.map(() => 1)]);
  return { name, rows };
}
const b64 = (sheets) => workbook(sheets).toString("base64");

const FILE = b64([
  sheet("Януари", { 5: { Сервиз: 270, Стока: 305, "А/Д": 8000 }, 8: { Разни: 44, Сервиз: 110, Стока: 137.5 } }, { withDayCol: false }),
  sheet("Февруари", { 2: { Сервиз: 130, Сметки: 610 }, 28: { Телефони: 140, Гориво: 58 } }),
  sheet("Декември", {}),
]);

let srv, api;
before(async () => {
  srv = await startServer({ files: { "data.json": path.join(ROOT, "data-demo.json") } });
  api = srv.request;
  await api("POST", "/api/setup", { username: "admin", password: "secret123" });
});
after(() => srv?.stop());

const MAP = { Разни: "misc", Сервиз: "service", Стока: "goods", "А/Д": "salaries", Сметки: "bills", Гориво: "fuel", Онлине: "", Телефони: "phones" };
async function expensesOf(from, to, store = "s1") {
  const days = (await api("GET", `/api/report?from=${from}&to=${to}&store=${store}`)).json.days;
  return Object.fromEntries(days.filter((d) => Object.keys(d.expenses).length).map((d) => [d.date, d.expenses]));
}

test("преглед: месеци, дни, суми, предложени колони; приходите и редът „Sum“ не се внасят", async () => {
  const r = await api("POST", "/api/import/preview", { store: "s1", file: FILE, fileName: "Разходи2025.xlsx" });
  assert.equal(r.status, 200, r.text);
  const p = r.json;
  assert.equal(p.year, 2025); // от името на файла
  assert.deepEqual(p.months.map((x) => [x.sheet, x.days, x.total]), [["Януари", 2, 8866.5], ["Февруари", 2, 938]]);
  assert.deepEqual(p.skipped, ["Декември (няма разходи)"]);
  assert.deepEqual(p.errors, []);
  assert.equal(p.warningCount, 0);
  assert.equal(p.from, "2025-01-05");
  assert.equal(p.to, "2025-02-28");
  assert.equal(p.days, 4);
  const sug = Object.fromEntries(p.columns.map((c) => [c.name, c.suggest]));
  assert.deepEqual(sug, { Разни: "misc", Сервиз: "service", Стока: "goods", "А/Д": "", Сметки: "bills", Гориво: "fuel", Онлине: "eshop", Телефони: "phones" });
  assert.equal(p.columns.find((c) => c.name === "Онлине").count, 0);
  assert.deepEqual(p.existing, []);
});

test("запис: без избрана колона за „А/Д“ се отказва; после се записва с копие и история", async () => {
  const { "А/Д": _, ...partial } = MAP;
  const bad = await api("POST", "/api/import/apply", { store: "s1", file: FILE, fileName: "Разходи2025.xlsx", mapping: partial });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /А\/Д/);

  const r = await api("POST", "/api/import/apply", { store: "s1", file: FILE, fileName: "Разходи2025.xlsx", mapping: MAP });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.imported, 4);
  assert.equal(r.json.total, 9804.5);
  const e = await expensesOf("2025-01-01", "2025-02-28");
  assert.deepEqual(e["2025-01-05"], { service: 270, goods: 305, salaries: 8000 });
  assert.deepEqual(e["2025-01-08"].misc, [{ name: "от Excel", value: 44 }]);
  assert.equal(e["2025-02-28"].fuel, 58);
  assert.deepEqual(await expensesOf("2025-01-01", "2025-02-28", "s2"), {}); // другият магазин не е пипнат

  assert.ok(fs.readdirSync(path.join(srv.dir, "backups")).some((f) => f.endsWith("-before-import.json")));
  const h = (await api("GET", "/api/history?from=2000-01-01&to=2100-01-01&kind=change")).json.entries;
  assert.ok(h.some((x) => x.action === "import" && /4 дни/.test(x.text)), JSON.stringify(h.map((x) => x.text)));
});

test("дни с въведени разходи: пропускат се, освен ако не е избрано „замени“; другите колони остават", async () => {
  await api("POST", "/api/expense", { store: "s1", date: "2025-02-02", col: "eshop", value: 77 });
  const p = (await api("POST", "/api/import/preview", { store: "s1", file: FILE, year: 2025 })).json;
  assert.equal(p.existing.length, 4);

  const skip = (await api("POST", "/api/import/apply", { store: "s1", file: FILE, year: 2025, mapping: { ...MAP, Сервиз: "goods" } })).json;
  assert.equal(skip.imported, 0);
  assert.equal(skip.skipped, 4);
  assert.equal((await expensesOf("2025-02-02", "2025-02-02"))["2025-02-02"].service, 130);

  const over = (await api("POST", "/api/import/apply", { store: "s1", file: FILE, year: 2025, overwrite: true, mapping: { ...MAP, Сервиз: "", Сметки: "new" } })).json;
  assert.equal(over.imported, 4);
  assert.deepEqual(over.created, ["Сметки"]);
  const newCol = over.expenseColumns.find((c) => c.name === "Сметки" && c.id !== "bills");
  const d = (await expensesOf("2025-02-02", "2025-02-02"))["2025-02-02"];
  assert.equal(d.eshop, 77);    // не е от файла — остава
  assert.equal(d.service, 130); // „Сервиз“ не се внася този път — старата стойност остава
  assert.equal(d[newCol.id], 610);
});

test("грешки: несъществуващ ден със суми, повреден файл, „Всички магазини“, сбор, който не съвпада", async () => {
  const feb = b64([sheet("Февруари", { 30: { Сервиз: 10 } })]);
  const p = (await api("POST", "/api/import/preview", { store: "s1", file: feb, year: 2025 })).json;
  assert.match(p.errors[0], /няма 30-во число/);
  const a = await api("POST", "/api/import/apply", { store: "s1", file: feb, year: 2025, mapping: MAP });
  assert.equal(a.status, 400);
  assert.match(a.json.error, /грешки/);

  const broken = await api("POST", "/api/import/preview", { store: "s1", file: Buffer.from("not a zip").toString("base64"), year: 2025 });
  assert.equal(broken.status, 400);
  assert.match(broken.json.error, /не може да се прочете/);

  const all = await api("POST", "/api/import/preview", { store: "all", file: FILE, year: 2025 });
  assert.equal(all.status, 400);

  // сборът не съвпада с „Разход Магазин (общо)“ — предупреждение, не грешка
  const off = sheet("Март", { 3: { Стока: 50 } });
  off.rows[3][9] = 60;
  const w = (await api("POST", "/api/import/preview", { store: "s1", file: b64([off]), year: 2025 })).json;
  assert.equal(w.errors.length, 0);
  assert.match(w.warnings[0], /не е равен/);
});

test("четене на файл от Excel: общи текстове (sharedStrings), формули, дата в Excel", () => {
  const { parseExpenses } = require("../src/import-parse");
  const ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
  const files = {
    "[Content_Types].xml": "<Types/>",
    "xl/workbook.xml": `<workbook ${ns} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Разходи" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`,
    "xl/sharedStrings.xml": `<sst ${ns}><si><t>Дата</t></si><si><r><t>Сер</t></r><r><t>виз</t></r></si><si><t>Стока &amp; др.</t></si></sst>`,
    "xl/worksheets/sheet1.xml": `<worksheet ${ns}><sheetData>
      <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>
      <row r="2"><c r="A2" s="3"><v>45663</v></c><c r="B2"><f>10+5</f><v>15</v></c><c r="C2"><v>2.5</v></c></row>
      <row r="3"><c r="A3" t="inlineStr"><is><t>07.01.2025</t></is></c><c r="B3"/><c r="C3"><v>4</v></c></row>
    </sheetData></worksheet>`,
  };
  const r = parseExpenses(zip(files), 2030);
  assert.deepEqual(r.headers, ["Сервиз", "Стока & др."]);
  assert.deepEqual(r.days, [
    { date: "2025-01-06", values: { Сервиз: 15, "Стока & др.": 2.5 } },
    { date: "2025-01-07", values: { "Стока & др.": 4 } },
  ]);
});
