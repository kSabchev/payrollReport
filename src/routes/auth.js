// Вход и акаунти. `public` — достъпни без вход; `private` — само за влезли.
const { AUTH } = require("../config");
const { data, saveData } = require("../data");
const { logHistory, audit } = require("../history");
const {
  normUser, findUser, hashPassword, passwordOk, checkPassword, checkNewUser,
  lockedMessage, recordFail, clearFails, startSession, endSession, dropSessions, usersList,
} = require("../auth");

const publicRoutes = {
  "GET /api/session": async (_, __, user) => ({ auth: AUTH, user: user && { name: user.name }, setup: AUTH && !data.users.length }),

  "POST /api/login": async (_, b, __, req, res) => {
    const name = normUser(b.username);
    const locked = lockedMessage(name);
    if (locked) throw new Error(locked);
    const user = findUser(name);
    if (!user || !passwordOk(user, b.password)) {
      recordFail(name);
      logHistory({ kind: "change", action: "login-failed", text: `Неуспешен вход с име „${name}“` });
      throw new Error("Грешно име или парола");
    }
    clearFails(name);
    startSession(req, res, user);
    audit({ login: user.username, name: user.username }, "login", "Вход");
    return { ok: true };
  },

  // Първият акаунт се създава от страницата, само докато няма нито един
  "POST /api/setup": async (_, b, __, req, res) => {
    if (!AUTH || data.users.length) throw new Error("Вече има създаден акаунт");
    const username = checkNewUser(b.username, b.password);
    const user = { username, ...hashPassword(b.password), createdAt: new Date().toISOString() };
    data.users.push(user);
    startSession(req, res, user);
    audit({ login: username, name: username }, "users", `Създаден първи акаунт „${username}“`);
    return { ok: true };
  },

  "POST /api/logout": async (_, __, user, req, res) => {
    endSession(req, res);
    if (user) audit(user, "logout", "Изход");
    return { ok: true };
  },
};

const privateRoutes = {
  // Акаунти: добавяне, смяна на парола, изтриване
  "POST /api/users": async (_, b, user) => {
    if (!AUTH) throw new Error("В демо режим няма акаунти");
    if (b.action === "add") {
      const username = checkNewUser(b.username, b.password);
      if (findUser(username)) throw new Error(`Вече има акаунт „${username}“`);
      data.users.push({ username, ...hashPassword(b.password), createdAt: new Date().toISOString() });
      saveData();
      audit(user, "users", `Нов акаунт „${username}“`);
    } else if (b.action === "password") {
      const target = findUser(b.username);
      if (!target) throw new Error("Няма такъв акаунт");
      checkPassword(b.password);
      Object.assign(target, hashPassword(b.password));
      dropSessions(target.username, user.sessionId); // излиза от другите устройства
      saveData();
      audit(user, "users", target.username === user.login ? "Смяна на собствената парола" : `Смяна на паролата на „${target.username}“`);
    } else if (b.action === "delete") {
      const target = findUser(b.username);
      if (!target) throw new Error("Няма такъв акаунт");
      if (target.username === user.login) throw new Error("Не можете да изтриете собствения си акаунт");
      data.users = data.users.filter((u) => u !== target);
      dropSessions(target.username);
      saveData();
      audit(user, "users", `Изтрит акаунт „${target.username}“`);
    } else throw new Error("Невалидно действие");
    return { ok: true, users: usersList() };
  },
};

module.exports = { publicRoutes, privateRoutes };
