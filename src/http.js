// HTTP: API (JSON) и статичните файлове на страницата от public/
const http = require("http");
const fs = require("fs");
const path = require("path");
const { AUTH, PUBLIC_DIR } = require("./config");
const { userOf } = require("./auth");
const { publicRoutes, privateRoutes } = require("./routes/auth");

const routes = {
  ...require("./routes/report"),
  ...require("./routes/entries"),
  ...require("./routes/setup"),
  ...privateRoutes,
};

function send(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
  });
}

// Статични файлове: само от public/, само познати видове. Страницата и скриптовете не съдържат
// данни, затова се дават и без вход (данните идват от API-то, което иска вход).
const TYPES = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
};

function serveStatic(pathname, res) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { return false; }
  if (rel === "/") rel = "/index.html";
  const file = path.resolve(PUBLIC_DIR, "." + rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !TYPES[path.extname(file)]) return false;
  let stat;
  try { stat = fs.statSync(file); } catch { return false; }
  if (!stat.isFile()) return false;
  // no-cache: браузърът проверява за нова версия при всяко зареждане (след обновяване на програмата)
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file)], "Cache-Control": "no-cache", "Last-Modified": stat.mtime.toUTCString() });
  fs.createReadStream(file).pipe(res);
  return true;
}

function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const key = `${req.method} ${url.pathname}`;
    const h = publicRoutes[key] || routes[key];
    if (h) {
      const user = userOf(req);
      try {
        if (AUTH && !user && !publicRoutes[key]) return send(res, 401, { error: "Влезте отново", login: true });
        // Само JSON: така чужда страница не може да прати заявка от браузъра на влязъл потребител (CSRF)
        if (req.method === "POST" && !String(req.headers["content-type"] || "").startsWith("application/json"))
          return send(res, 415, { error: "Очаква се JSON" });
        const body = req.method === "POST" ? await readBody(req) : null;
        send(res, 200, await h(url.searchParams, body, user, req, res));
      } catch (e) {
        send(res, 400, { error: e.message });
      }
      return;
    }
    if (req.method === "GET" && serveStatic(url.pathname, res)) return;
    res.writeHead(404); res.end();
  });
}

module.exports = { createServer };
