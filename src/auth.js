// Акаунти и вход.
// Всички акаунти са администратори. Паролите се пазят само като scrypt хеш със сол.
// След вход браузърът получава бисквитка (HttpOnly, SameSite=Strict) със случаен ключ;
// в data.json се пази само SHA-256 на ключа. Сесията важи 30 дни.
const crypto = require("crypto");
const { AUTH } = require("./config");
const { data, saveData } = require("./data");

const SESSION_DAYS = 30;
const COOKIE = "payroll_session";
const MAX_FAILS = 5, LOCK_MINUTES = 5;
const fails = new Map(); // потребител -> { count, until }

const normUser = (s) => String(s || "").trim().toLowerCase();
const tokenId = (t) => crypto.createHash("sha256").update(t).digest("hex");
const findUser = (name) => data.users.find((u) => u.username === normUser(name));

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString("hex") };
}

function passwordOk(user, password) {
  const h = crypto.scryptSync(String(password || ""), user.salt, 64);
  return crypto.timingSafeEqual(h, Buffer.from(user.hash, "hex"));
}

function checkPassword(password) {
  if (String(password || "").length < 8) throw new Error("Паролата трябва да е поне 8 знака");
}

function checkNewUser(username, password) {
  const u = normUser(username);
  if (!/^[\p{L}\p{N}._-]{2,32}$/u.test(u)) throw new Error("Името трябва да е от 2 до 32 букви, цифри, точка, тире или долна черта, без интервали");
  checkPassword(password);
  return u;
}

// Грешни пароли: след MAX_FAILS акаунтът се заключва за LOCK_MINUTES
function lockedMessage(name) {
  const f = fails.get(name), now = Date.now();
  return f?.until > now ? `Твърде много грешни опити. Опитайте отново след ${Math.ceil((f.until - now) / 60000)} мин.` : null;
}
function recordFail(name) {
  const f = fails.get(name), now = Date.now();
  const count = (f && !f.until ? f.count : 0) + 1; // след изтекло заключване броенето започва отначало
  if (fails.size > 1000) fails.clear();
  fails.set(name, count >= MAX_FAILS ? { count: 0, until: now + LOCK_MINUTES * 60000 } : { count, until: 0 });
}
const clearFails = (name) => fails.delete(name);

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setSessionCookie(req, res, token, maxAge) {
  const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`);
}

function startSession(req, res, user) {
  const now = Date.now();
  for (const [id, s] of Object.entries(data.sessions)) if (s.expires < now) delete data.sessions[id];
  const token = crypto.randomBytes(32).toString("base64url");
  data.sessions[tokenId(token)] = { username: user.username, created: now, expires: now + SESSION_DAYS * 864e5 };
  user.lastLogin = new Date(now).toISOString();
  saveData();
  setSessionCookie(req, res, token, SESSION_DAYS * 86400);
}

function sessionOf(req) {
  const t = parseCookies(req)[COOKIE];
  if (!t) return null;
  const id = tokenId(t), s = data.sessions[id];
  return s && s.expires > Date.now() ? { id, ...s } : null;
}

function endSession(req, res) {
  const s = sessionOf(req);
  if (s) { delete data.sessions[s.id]; saveData(); }
  setSessionCookie(req, res, "", 0);
}

// { login, name, sessionId } или null
function userOf(req) {
  if (!AUTH) return null;
  const s = sessionOf(req);
  const u = s && findUser(s.username);
  return u ? { login: u.username, name: u.username, sessionId: s.id } : null;
}

const dropSessions = (username, keepId) => {
  for (const [id, s] of Object.entries(data.sessions)) if (s.username === username && id !== keepId) delete data.sessions[id];
};

const usersList = () => data.users.map(({ username, createdAt, lastLogin }) => ({ username, createdAt, lastLogin }));

module.exports = {
  normUser, findUser, hashPassword, passwordOk, checkPassword, checkNewUser,
  lockedMessage, recordFail, clearFails, startSession, endSession, userOf, dropSessions, usersList,
};
