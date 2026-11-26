// Предупреждения за резервните копия

// ------------------------------------------------------------ Резервни копия: предупреждение
const backupWhen = (b) => (b.at ? new Date(b.at).toLocaleString("bg-BG", { dateStyle: "short", timeStyle: "short" }) : null);

function backupProblemText(b) {
  const last = backupWhen(b) ? ` Последно успешно копие: ${backupWhen(b)}.` : " Няма нито едно успешно копие.";
  if (b.problem?.kind === "error") return `Резервното копие на данните не е направено: ${b.problem.message}.${last}`;
  return `Копието за ${b.problem?.date ? short(b.problem.date, true) : "деня"} в ${b.time} не е направено.${last}`;
}

// Червена лента над обобщението на всички страници, докато има проблем
function renderAlerts() {
  const b = S.meta.backup;
  $("#alerts").innerHTML = dbAlertHtml() + (b?.problem ? `<div class="alert" role="alert"><div><strong>Проблем с резервните копия.</strong>
      ${esc(backupProblemText(b))}</div>
    <div class="actions"><button class="ghost" data-backupnow>Опитай сега</button><button class="ghost" data-tab-go="settings">Настройки</button></div></div>` : "");
}

// Изскачащ прозорец веднъж на сесия за всеки нов проблем
function askBackupProblem() {
  const b = S.meta.backup;
  if (!b?.problem || dlg.open) return;
  const key = "backupProblem:" + (b.problem.message || b.problem.kind) + ":" + today();
  if (sessionStorage.getItem(key)) return;
  sessionStorage.setItem(key, "1");
  showDialog(`<h2>Проблем с резервните копия</h2>
    <p>${esc(backupProblemText(b))}</p>
    <p class="muted">Разходите се пазят само в тази програма, затова копието е важно. Проверете дали има място на диска и права за
      папката <strong>${esc(b.dir)}</strong>. Предупреждението остава горе, докато копието не се направи успешно.</p>
    <div class="actions"><button class="ghost" id="cancel">Затвори</button><button class="primary" data-backupnow>Опитай сега</button></div>`,
    (root) => { $("#cancel", root).onclick = closeDialog; });
}

async function backupNow() {
  const msg = $("#backupMsg");
  try {
    const r = await api("/api/backup", {});
    S.meta.backup = r.backup;
    if (dlg.open) closeDialog();
    render();
    if ($("#backupMsg")) { $("#backupMsg").textContent = "Копието е направено."; $("#backupMsg").className = "muted"; }
    else alert("Копието е направено.");
  } catch (err) {
    if (dlg.open) closeDialog();
    await refreshMeta().catch(() => {});
    render();
    if (msg && $("#backupMsg")) { $("#backupMsg").textContent = err.message; $("#backupMsg").className = "err"; }
    else alert(err.message);
  }
}
