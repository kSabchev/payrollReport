// Отчет приходи / разходи с данни от базата на Microinvest Склад Про (SQL Server)
// Node.js 20.12+.  Старт: node server.js   Демо: MOCK=1 node server.js
// Връзката с базата се настройва в .env (вижте .env.example).
//
// Кодът е в src/:
//   config.js       настройки от .env          data.js      data.json (зареждане, преобразуване, запис)
//   util.js         дати, числа, текст         history.js   история на промените и четенията
//   backup.js       резервни копия             auth.js      акаунти и сесии
//   microinvest.js  SQL, групи, продажби       mock.js      демо данни
//   stores.js       магазини, оборотни пари, отчет по дни
//   routes/*.js     API                        http.js      HTTP сървър и статични файлове
// Страницата е в public/.

const { MOCK, PORT, HOST, DATA_FILE, AUTH } = require("./src/config");
const { data, saveData, migratedFrom } = require("./src/data");
const { logHistory } = require("./src/history");
const { backup, startBackups } = require("./src/backup");
const { connectionInfo } = require("./src/microinvest");
const { createServer } = require("./src/http");

// След преобразуване на данните: копие на стария файл, после запис в новия вид
if (migratedFrom()) {
  let file = null;
  try { file = backup("before-stores"); } catch (e) { console.error("Копие преди преобразуване:", e.message); }
  saveData();
  console.log(`Данните са преобразувани за няколко магазина${file ? `. Копие на старите: backups/${file}` : ""}`);
  logHistory({ kind: "change", action: "migration", text: `Данните са преобразувани за няколко магазина${file ? ` (копие: ${file})` : ""}` });
}

startBackups();

const server = createServer();
server.listen(PORT, HOST, () => {
  console.log(`Отчет: http://${HOST || "localhost"}:${server.address().port}`);
  const c = connectionInfo();
  console.log(MOCK ? "Демо режим с примерни данни" : c.configured ? `Microinvest: ${c.server}, база ${c.database}, потребител ${c.user}`
    : "Внимание: връзката с базата не е настроена (вижте .env.example)");
  console.log(`Данните се пазят в ${DATA_FILE}`);
  if (AUTH) console.log(data.users.length ? `Акаунти: ${data.users.map((u) => u.username).join(", ")}`
    : "Няма акаунти. Отворете програмата в браузъра и създайте първия.");
});
