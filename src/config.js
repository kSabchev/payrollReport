// Настройки от средата и от .env (вижте .env.example)
const path = require("path");

const ROOT = path.join(__dirname, "..");
try { process.loadEnvFile(path.join(ROOT, ".env")); } catch {}

const MOCK = process.env.MOCK === "1";
// Папка за данните, историята и копията (по подразбиране до server.js; тестовете ползват временна)
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : ROOT;

module.exports = {
  ROOT,
  PUBLIC_DIR: path.join(ROOT, "public"),
  MOCK,
  PORT: Number(process.env.PORT || 3000),
  HOST: process.env.HOST || undefined, // 127.0.0.1 = само от този компютър (напр. зад tailscale serve)
  DATA_DIR,
  DATA_FILE: path.join(DATA_DIR, MOCK ? "data-demo.json" : "data.json"),
  HISTORY_DIR: path.join(DATA_DIR, MOCK ? "history-demo" : "history"),
  BACKUP_DIR: path.join(DATA_DIR, "backups"),
  // Час за ежедневното копие (BACKUP_TIME=ЧЧ:ММ)
  BACKUP_TIME: /^\d{1,2}:\d{2}$/.test(process.env.BACKUP_TIME || "") ? process.env.BACKUP_TIME : "21:05",
  RECENT_DAYS: 3, // последните N дни винаги се презареждат от базата
  // Вход с име и парола. В демо режим е изключен, освен ако DEMO_LOGIN=1.
  AUTH: !MOCK || process.env.DEMO_LOGIN === "1",
};
