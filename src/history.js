// История: един файл на месец, history/ГГГГ-ММ.jsonl, по един запис на ред. Само се добавя, не се променя.
// kind "change" — промяна от потребител; kind "sync" — четене от базата на Microinvest.
const fs = require("fs");
const path = require("path");
const { HISTORY_DIR } = require("./config");
const { fmt, daysBetween } = require("./util");

function logHistory(entry) {
  try {
    const at = new Date();
    fs.mkdirSync(HISTORY_DIR, { recursive: true });
    fs.appendFileSync(path.join(HISTORY_DIR, fmt(at).slice(0, 7) + ".jsonl"), JSON.stringify({ at: at.toISOString(), ...entry }) + "\n");
  } catch (e) { console.error("История:", e.message); }
}

const who = (user) => (user ? { user: user.login, name: user.name } : {});
const audit = (user, action, text, extra = {}) => logHistory({ kind: "change", ...who(user), action, text, ...extra });

// Записи за периода, най-новите първи; kind: "change" | "sync" | null (всички)
function readHistory(from, to, kind, limit = 2000) {
  const months = new Set(daysBetween(from, to).map((d) => d.slice(0, 7)));
  const out = [];
  for (const mo of [...months].sort().reverse()) {
    let text;
    try { text = fs.readFileSync(path.join(HISTORY_DIR, mo + ".jsonl"), "utf8"); } catch { continue; }
    const lines = text.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i]) continue;
      let e; try { e = JSON.parse(lines[i]); } catch { continue; }
      const day = fmt(new Date(e.at));
      if (day < from || day > to || (kind && e.kind !== kind)) continue;
      out.push(e);
      if (out.length >= limit) return { entries: out, truncated: true };
    }
  }
  return { entries: out, truncated: false };
}

module.exports = { logHistory, who, audit, readHistory };
