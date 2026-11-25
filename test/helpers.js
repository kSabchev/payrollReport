// Пуска истинския server.js във временна папка и праща заявки към него.
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

// files: { "data.json": съдържание или път за копиране }
// prepare(dir) — по желание, преди стартиране (напр. стари дати на файлове)
async function startServer({ env = {}, files = {}, prepare } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "payroll-test-"));
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(dir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (typeof content === "string" && fs.existsSync(content)) fs.copyFileSync(content, target);
    else fs.writeFileSync(target, typeof content === "string" ? content : JSON.stringify(content));
  }
  if (prepare) prepare(dir);
  const proc = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: dir,
    // Празните стойности не позволяват на евентуален .env да включи истинска база
    env: { ...process.env, PORT: "0", HOST: "127.0.0.1", DATA_DIR: dir,
      MI_SQL_DATABASE: "", MI_SQL_USER: "", MI_SQL_PASSWORD: "", MOCK: "", DEMO_LOGIN: "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Сървърът не стартира:\n" + output)), 10000);
    const onData = (chunk) => {
      output += chunk;
      const m = /Отчет: (http:\/\/\S+)/.exec(output);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", (c) => (output += c));
    proc.on("exit", (code) => { clearTimeout(timer); reject(new Error(`Сървърът спря (${code}):\n${output}`)); });
  });
  proc.removeAllListeners("exit");

  // Клиент с бисквитки, като браузър
  function client() {
    let cookie = "";
    return async function request(method, p, body, { contentType = "application/json" } = {}) {
      const res = await fetch(url + p, {
        method,
        headers: { ...(body !== undefined ? { "Content-Type": contentType } : {}), ...(cookie ? { Cookie: cookie } : {}) },
        body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      });
      const set = res.headers.get("set-cookie");
      if (set) cookie = set.split(";")[0].endsWith("=") ? "" : set.split(";")[0];
      const text = await res.text();
      let json = null; try { json = JSON.parse(text); } catch {}
      return { status: res.status, json, text, headers: res.headers };
    };
  }

  return {
    url, dir, client, request: client(),
    output: () => output,
    readJson: (name) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")),
    async stop() {
      if (proc.exitCode === null) { proc.kill(); await new Promise((r) => proc.once("exit", r)); }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

module.exports = { startServer, ROOT };
