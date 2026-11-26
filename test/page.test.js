// Страницата: скриптовете са валиден JavaScript, а сървърът дава само файловете от public/
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { startServer, ROOT } = require("./helpers");

const PUBLIC = path.join(ROOT, "public");
const html = fs.readFileSync(path.join(PUBLIC, "index.html"), "utf8");
const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);

test("index.html: всички скриптове съществуват и са валиден JavaScript", () => {
  assert.ok(scripts.length > 5);
  for (const src of scripts) {
    const code = fs.readFileSync(path.join(PUBLIC, src), "utf8");
    assert.doesNotThrow(() => new vm.Script(code, { filename: src }), src);
  }
});

test("скриптовете заедно нямат повтарящи се имена (общ глобален обхват)", () => {
  const all = scripts.map((src) => fs.readFileSync(path.join(PUBLIC, src), "utf8")).join("\n;\n");
  assert.doesNotThrow(() => new vm.Script(all, { filename: "всички скриптове" }));
});

test("няма вградени скриптове и стилове — всичко е във файлове", () => {
  assert.doesNotMatch(html, /<script>(?!<\/script>)/);
  assert.doesNotMatch(html, /<style>/);
});

let srv;
before(async () => { srv = await startServer({ env: { MOCK: "1" }, files: { "data-demo.json": path.join(ROOT, "data-demo.json") } }); });
after(() => srv?.stop());

test("сървърът дава страницата, стиловете и скриптовете с правилен тип", async () => {
  const get = (p) => fetch(srv.url + p);
  for (const [p, type] of [["/", "text/html"], ["/index.html", "text/html"], ["/app.css", "text/css"], ["/js/core.js", "text/javascript"]]) {
    const r = await get(p);
    assert.equal(r.status, 200, p);
    assert.match(r.headers.get("content-type"), new RegExp(type), p);
    assert.equal(r.headers.get("cache-control"), "no-cache");
  }
});

test("файлове извън public/ не се дават", async () => {
  for (const p of ["/server.js", "/data-demo.json", "/%2e%2e/server.js", "/js/%2e%2e/%2e%2e/server.js", "/src/config.js", "/js/", "/nope.js"]) {
    const r = await fetch(srv.url + p);
    assert.equal(r.status, 404, p);
  }
});
