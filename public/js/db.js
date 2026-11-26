// Предупреждение при прекъсната връзка с базата на Microinvest: червена лента и изскачащ прозорец
// с „от кога“ и „последно успешно четене“. Сървърът проверява връзката на всеки 5 минути.

const dbWhen = (iso) => new Date(iso).toLocaleString("bg-BG", { dateStyle: "short", timeStyle: "short" });
const dbDown = () => { const d = S.meta?.db; return !!(d && !d.mock && !d.ok); };

function dbProblemText(d) {
  const since = d.since ? `от ${dbWhen(d.since)}` : "";
  const last = d.lastOk ? `Последно успешно четене: ${dbWhen(d.lastOk)}.` : "Още няма успешно четене.";
  return `Прекъсната ${since}. ${last} Показват се запазените данни. Причина: ${d.error}`;
}

function dbAlertHtml() {
  if (!dbDown()) return "";
  return `<div class="alert" role="alert"><div><strong>Няма връзка с базата на Microinvest.</strong> ${esc(dbProblemText(S.meta.db))}</div>
    <div class="actions"><button class="ghost" data-dbcheck>Опитай отново</button><button class="ghost" data-tab-go="settings">Настройки</button></div></div>`;
}

// Веднъж на сесия за всяко прекъсване
function askDbProblem() {
  if (!dbDown() || dlg.open) return;
  const d = S.meta.db, key = "dbProblem:" + (d.since || d.error);
  if (sessionStorage.getItem(key)) return;
  sessionStorage.setItem(key, "1");
  showDialog(`<h2>Няма връзка с базата на Microinvest</h2>
    <p>${esc(dbProblemText(d))}</p>
    <p class="muted">Разходите могат да се въвеждат и сега. Продажбите ще се обновят, когато връзката се възстанови.
      Проверете дали SQL Server работи и дали настройките в .env са верни.</p>
    <div class="actions"><button class="ghost" id="cancel">Затвори</button><button class="primary" data-dbcheck>Опитай отново</button></div>`,
    (root) => { $("#cancel", root).onclick = closeDialog; });
}

async function dbCheck() {
  try {
    const r = await api("/api/db-check", {});
    S.meta.db = r.db;
    if (dlg.open) closeDialog();
    if (r.db.ok) load(); else { render(); alert("Все още няма връзка: " + r.db.error); }
  } catch (err) { alert(err.message); }
}

document.addEventListener("click", (e) => { if (e.target.dataset?.dbcheck !== undefined) dbCheck(); });
