// Резервни копия.
// Всеки ден в 21:05 (BACKUP_TIME в .env) data.json се копира в backups/data-ГГГГ-ММ-ДД.json.
// Проверява се всяка минута. Ако програмата не е работила в 21:05, копието за пропуснатия ден се
// прави веднага при стартиране. Копията не се трият — пазят се завинаги.
// backup("причина") прави допълнително копие с час, напр. ръчно или преди промяна на структурата.
const fs = require("fs");
const path = require("path");
const { MOCK, DATA_FILE, BACKUP_DIR, BACKUP_TIME } = require("./config");
const { pad, fmt } = require("./util");
const { logHistory } = require("./history");

const BACKUP_LATE_MINUTES = 10; // ако копието за деня липсва толкова след часа, е проблем
let lastBackup = { at: null, file: null, error: null };

// Последният минал час за копие (днес или вчера) и името на файла за него
function backupSlot(now = new Date()) {
  const [h, m] = BACKUP_TIME.split(":").map(Number);
  const slot = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m);
  if (slot > now) slot.setDate(slot.getDate() - 1);
  return { at: slot, file: `data-${fmt(slot)}.json` };
}

function writeBackup(name) {
  const now = new Date(), file = path.join(BACKUP_DIR, name);
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  fs.copyFileSync(DATA_FILE, file);
  fs.utimesSync(file, now, now); // Windows запазва датата на оригинала; копието трябва да е с часа на копиране
  lastBackup = { ...lastBackup, at: now.toISOString(), file: name, error: null };
  return name;
}

function backup(reason) {
  if (MOCK || !fs.existsSync(DATA_FILE)) return null;
  const now = new Date();
  return writeBackup(`data-${fmt(now)}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${reason}.json`);
}

// Разбираемо съобщение за честите грешки при запис на файл
function friendlyFsError(e) {
  const hint = { ENOSPC: "няма място на диска", EACCES: "няма права за запис в папката", EPERM: "няма права за запис в папката",
    EROFS: "дискът е само за четене", EEXIST: "на мястото на папката backups има файл", ENOTDIR: "на мястото на папката backups има файл",
    ENOENT: "папката или файлът липсва", EBUSY: "файлът е зает от друга програма" }[e.code];
  return hint ? `${hint} (${e.code})` : e.message;
}

// Грешката се записва в историята веднъж, а не на всеки опит
function backupFailed(err) {
  const message = friendlyFsError(err);
  if (lastBackup.error !== message) logHistory({ kind: "change", action: "backup-failed", text: `Резервното копие не е направено: ${message}` });
  lastBackup = { ...lastBackup, error: message };
  console.error("Резервно копие:", err.message);
}

// Копието за последния минал час, ако още го няма
function dailyBackup() {
  if (MOCK || !fs.existsSync(DATA_FILE)) return;
  const { file } = backupSlot();
  if (fs.existsSync(path.join(BACKUP_DIR, file))) return;
  try { writeBackup(file); } catch (e) { backupFailed(e); }
}

// Време на копие: по-късното от датата в името и датата на файла (старите копия на Windows
// може да носят датата на оригинала)
function backupTime(f) {
  const m = /^data-(\d{4})-(\d{2})-(\d{2})(?:-(\d{2})(\d{2})(\d{2}))?/.exec(f);
  const named = m ? new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)).getTime() : 0;
  return Math.max(named, fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs);
}

// problem: null | { kind: "error", message } | { kind: "missed", date } (копието за деня липсва след часа)
function backupStatus() {
  if (MOCK) return { mock: true };
  let count = 0;
  try {
    const files = fs.existsSync(BACKUP_DIR) ? fs.readdirSync(BACKUP_DIR).filter((f) => /^data-\d{4}-\d{2}-\d{2}.*\.json$/.test(f)) : [];
    count = files.length;
    if (!lastBackup.at) {
      const latest = files.map((f) => ({ f, t: backupTime(f) })).sort((a, b) => b.t - a.t)[0];
      if (latest) lastBackup = { ...lastBackup, at: new Date(latest.t).toISOString(), file: latest.f };
    }
  } catch {}
  const slot = backupSlot();
  let problem = null;
  if (lastBackup.error) problem = { kind: "error", message: lastBackup.error };
  else if (fs.existsSync(DATA_FILE) && Date.now() - slot.at > BACKUP_LATE_MINUTES * 60000 && !fs.existsSync(path.join(BACKUP_DIR, slot.file)))
    problem = { kind: "missed", date: fmt(slot.at) };
  return { ...lastBackup, problem, dir: BACKUP_DIR, time: BACKUP_TIME, count };
}

// Проверка при стартиране и после всяка минута
function startBackups() {
  dailyBackup();
  setInterval(dailyBackup, 60 * 1000).unref();
}

module.exports = { backup, backupFailed, backupStatus, friendlyFsError, startBackups };
