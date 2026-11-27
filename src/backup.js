// Резервни копия.
// Всеки ден в 21:05 (BACKUP_TIME в .env) данните се записват в backups/data-ГГГГ-ММ-ДД.json.
// Проверява се всяка минута. Ако програмата не е работила в 21:05, копието за пропуснатия ден се
// прави веднага при стартиране. Копията не се трият — пазят се завинаги.
// В копието няма продажбите (cache): те винаги могат да се изтеглят наново от Microinvest.
// BACKUP_COPY_DIR: всяко копие се записва и във втора папка (друг диск или NAS). Ако тя не е
// достъпна, опитът се повтаря всяка минута, а липсващите там копия се допълват.
// BACKUP_COPY_USER/BACKUP_COPY_PASSWORD: за мрежова папка програмата се свързва с „net use“ с този
// потребител. Нужно е, защото услугата работи като SYSTEM и не вижда паролите, запазени в Explorer.
// backup("причина") прави допълнително копие с час, напр. ръчно или преди промяна на структурата.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { MOCK, DATA_FILE, BACKUP_DIR, BACKUP_COPY_DIR, BACKUP_COPY_USER, BACKUP_COPY_PASSWORD, BACKUP_TIME } = require("./config");
const { pad, fmt } = require("./util");
const { logHistory } = require("./history");

const BACKUP_LATE_MINUTES = 10; // ако копието за деня липсва толкова след часа, е проблем
const COPY_DIR = BACKUP_COPY_DIR && path.resolve(BACKUP_COPY_DIR) !== path.resolve(BACKUP_DIR) ? BACKUP_COPY_DIR : null;
const isBackup = (f) => /^data-\d{4}-\d{2}-\d{2}.*\.json$/.test(f);
let lastBackup = { at: null, file: null, error: null };
let copy = { error: null, at: null };

// ------------------------------------------------------------ Мрежова папка (NAS)
const SHARE = COPY_DIR && /^\\\\[^\\]+\\[^\\]+/.exec(COPY_DIR)?.[0]; // \\сървър\папка
const runAs = () => { try { return os.userInfo().username; } catch { return ""; } };
let share = { tried: false, error: null };

// Грешките на „net use“ по номер (текстът му е на езика на Windows и често с грешна кодировка)
const NET_ERRORS = {
  53: "мрежовият път не е намерен — проверете името на компютъра (NAS)",
  67: "споделената папка не е намерена — проверете пътя",
  86: "грешна парола за NAS",
  1326: "грешно име или парола за NAS",
  1327: "потребителят на NAS има ограничение за вход",
  1330: "паролата за NAS е изтекла",
  1331: "потребителят на NAS е изключен",
  1909: "потребителят на NAS е заключен след много грешни опити",
  1219: null, // вече има връзка с тази папка — не е грешка
};

// Свързва се с мрежовата папка с потребителя от .env. Само веднъж (и при ръчно копие): при грешна
// парола опит на всяка минута би заключил потребителя на NAS.
function connectShare(force = false) {
  if (!SHARE || !BACKUP_COPY_USER || process.platform !== "win32") return;
  if (share.tried && !force) return;
  share.tried = true;
  try {
    execFileSync("net", ["use", SHARE, BACKUP_COPY_PASSWORD, `/user:${BACKUP_COPY_USER}`, "/persistent:no"],
      { windowsHide: true, timeout: 20000, stdio: ["ignore", "pipe", "pipe"] });
    share.error = null;
  } catch (e) {
    // Без e.message: в него е командата заедно с паролата
    const out = `${e.stdout || ""} ${e.stderr || ""}`;
    const code = Number(/\b(\d{2,4})\b/.exec(out)?.[1]);
    if (code in NET_ERRORS && NET_ERRORS[code] === null) { share.error = null; return; }
    share.error = NET_ERRORS[code] || (e.code === "ETIMEDOUT" ? "NAS не отговаря" : `net use завърши с грешка${code ? ` ${code}` : ""}`);
    console.error("Връзка с мрежовата папка:", share.error);
  }
}

// Последният минал час за копие (днес или вчера) и името на файла за него
function backupSlot(now = new Date()) {
  const [h, m] = BACKUP_TIME.split(":").map(Number);
  const slot = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m);
  if (slot > now) slot.setDate(slot.getDate() - 1);
  return { at: slot, file: `data-${fmt(slot)}.json` };
}

// Записът минава през временен файл, за да не остане половин копие (напр. ако NAS прекъсне)
function writeFile(dir, name, content) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name), tmp = file + ".tmp";
  try {
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, file);
  } catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
  const now = new Date();
  fs.utimesSync(file, now, now);
}

// Данните без продажбите. Ако data.json не може да се прочете като JSON, се копира както е.
function backupContent() {
  const raw = fs.readFileSync(DATA_FILE, "utf8");
  try {
    const d = JSON.parse(raw);
    delete d.cache;
    return JSON.stringify(d, null, 1);
  } catch { return raw; }
}

function writeBackup(name) {
  const content = backupContent();
  writeFile(BACKUP_DIR, name, content);
  lastBackup = { ...lastBackup, at: new Date().toISOString(), file: name, error: null };
  if (COPY_DIR) {
    connectShare();
    try { writeFile(COPY_DIR, name, content); copyOk(); } catch (e) { copyFailed(e); }
  }
  return name;
}

function backup(reason) {
  if (MOCK || !fs.existsSync(DATA_FILE)) return null;
  if (reason === "manual" && copy.error) connectShare(true); // ръчното копие опитва връзката с NAS отново
  const now = new Date();
  return writeBackup(`data-${fmt(now)}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${reason}.json`);
}

// Разбираемо съобщение за честите грешки при запис на файл
function friendlyFsError(e) {
  const hint = { ENOSPC: "няма място на диска", EACCES: "няма права за запис в папката", EPERM: "няма права за запис в папката",
    EROFS: "дискът е само за четене", EEXIST: "на мястото на папката има файл", ENOTDIR: "на мястото на папката има файл",
    ENOENT: "папката или файлът липсва", EBUSY: "файлът е зает от друга програма",
    EHOSTUNREACH: "мрежовото устройство не е достъпно", ENETUNREACH: "мрежовото устройство не е достъпно",
    EIO: "грешка при четене или запис на устройството", UNKNOWN: "папката не е достъпна" }[e.code];
  return hint ? `${hint} (${e.code})` : e.message;
}

// Грешката се записва в историята веднъж, а не на всеки опит
function backupFailed(err) {
  const message = friendlyFsError(err);
  if (lastBackup.error !== message) logHistory({ kind: "change", action: "backup-failed", text: `Резервното копие не е направено: ${message}` });
  lastBackup = { ...lastBackup, error: message };
  console.error("Резервно копие:", err.message);
}

// Защо мрежовата папка не е достъпна: грешката от „net use“ или подсказка за потребителя на услугата
function copyMessage(err) {
  if (share.error) return `не може да се свърже с ${SHARE}: ${share.error}`;
  const msg = friendlyFsError(err);
  if (SHARE && ["UNKNOWN", "EPERM", "EACCES", "ENOENT"].includes(err.code) && !BACKUP_COPY_USER) {
    return `${msg}. Програмата работи като Windows потребител „${runAs()}“, който няма достъп до мрежовата папка `
      + `(Explorer ползва вашия потребител и запазената парола). Задайте BACKUP_COPY_USER и BACKUP_COPY_PASSWORD в .env `
      + `с потребител на NAS и рестартирайте услугата`;
  }
  return msg;
}

function copyFailed(err) {
  const message = copyMessage(err);
  if (copy.error !== message) logHistory({ kind: "change", action: "backup-copy-failed", text: `Копието във втората папка (${COPY_DIR}) не е направено: ${message}` });
  copy = { ...copy, error: message };
  console.error("Копие във втората папка:", err.message);
}

function copyOk() {
  if (copy.error) logHistory({ kind: "change", action: "backup-copy-restored", text: `Копирането във втората папка (${COPY_DIR}) работи отново` });
  copy = { error: null, at: new Date().toISOString() };
}

// Копира във втората папка копията, които я няма там (напр. докато NAS е бил изключен)
function syncCopies() {
  if (!COPY_DIR || !fs.existsSync(BACKUP_DIR)) return;
  connectShare();
  try {
    fs.mkdirSync(COPY_DIR, { recursive: true });
    const there = new Set(fs.readdirSync(COPY_DIR));
    for (const f of fs.readdirSync(BACKUP_DIR).filter(isBackup)) {
      if (!there.has(f)) writeFile(COPY_DIR, f, fs.readFileSync(path.join(BACKUP_DIR, f)));
    }
    copyOk();
  } catch (e) { copyFailed(e); }
}

// Копието за последния минал час, ако още го няма
function dailyBackup() {
  if (MOCK || !fs.existsSync(DATA_FILE)) return;
  const { file } = backupSlot();
  if (!fs.existsSync(path.join(BACKUP_DIR, file))) {
    try { writeBackup(file); } catch (e) { backupFailed(e); }
  }
  if (COPY_DIR && (copy.error || !fs.existsSync(path.join(COPY_DIR, file)))) syncCopies();
}

// Време на копие: по-късното от датата в името и датата на файла (старите копия на Windows
// може да носят датата на оригинала)
function backupTime(f) {
  const m = /^data-(\d{4})-(\d{2})-(\d{2})(?:-(\d{2})(\d{2})(\d{2}))?/.exec(f);
  const named = m ? new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)).getTime() : 0;
  return Math.max(named, fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs);
}

// problem: null | { kind: "error", message } | { kind: "missed", date } (копието за деня липсва след часа)
//   | { kind: "copy-error", message } (основното копие е наред, втората папка не е достъпна)
function backupStatus() {
  if (MOCK) return { mock: true };
  let count = 0;
  try {
    const files = fs.existsSync(BACKUP_DIR) ? fs.readdirSync(BACKUP_DIR).filter(isBackup) : [];
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
  else if (copy.error) problem = { kind: "copy-error", message: copy.error };
  return { ...lastBackup, problem, dir: BACKUP_DIR, time: BACKUP_TIME, count,
    copy: COPY_DIR ? { dir: COPY_DIR, at: copy.at, error: copy.error, runAs: runAs(), login: BACKUP_COPY_USER || null } : null };
}

// Проверка при стартиране и после всяка минута
function startBackups() {
  dailyBackup();
  if (COPY_DIR && !copy.error) syncCopies();
  setInterval(dailyBackup, 60 * 1000).unref();
}

module.exports = { backup, backupFailed, backupStatus, friendlyFsError, startBackups };
