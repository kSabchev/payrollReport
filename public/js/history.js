// Раздел История

// ------------------------------------------------------------ История
// Промени от администраторите и четенията от базата за избрания период
const HIST_KINDS = [["", "Всички"], ["change", "Промени"], ["sync", "Четене от базата"]];
const WHAT = { sales: "Продажби по групи", groups: "Групи артикули", objects: "Обекти", detail: "Артикули за ден" };

function historyFrame() {
  return `<div class="history-bar"><div class="seg" role="group" aria-label="Вид">
      ${HIST_KINDS.map(([k, l]) => `<button data-histkind="${k}" aria-pressed="${S.histKind === k}">${l}</button>`).join("")}</div>
      <span class="muted" id="histInfo">Зареждане…</span></div>
    <div class="tablewrap" id="histBody"></div>`;
}

let histSeq = 0;
async function loadHistory() {
  const p = period(), seq = ++histSeq;
  let r;
  try { r = await api(`/api/history?from=${p.from}&to=${p.to}&kind=${S.histKind}`); }
  catch (e) { if (seq === histSeq && $("#histInfo")) $("#histInfo").textContent = e.message; return; }
  if (seq !== histSeq || S.tab !== "history" || !$("#histBody")) return;
  $("#histInfo").textContent = r.entries.length
    ? `${r.entries.length} записа${r.truncated ? " (показани са последните; изберете по-кратък период)" : ""}` : "";
  $("#histBody").innerHTML = r.entries.length ? `<table class="history"><thead><tr><th>Време</th><th>Потребител</th><th>Събитие</th></tr></thead>
    <tbody>${r.entries.map(histRow).join("")}</tbody></table>` : `<div class="empty">Няма записи за периода.</div>`;
}

function histRow(e) {
  const t = new Date(e.at);
  const time = `${pad(t.getDate())}.${pad(t.getMonth() + 1)}.${t.getFullYear()} ${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`;
  const user = e.user ? `<span title="${esc(e.user)}">${esc(e.name || e.user)}</span>` : `<span class="muted">—</span>`;
  let what;
  if (e.kind === "sync") {
    const parts = [WHAT[e.what] || e.what];
    if (e.from) parts.push(e.from === e.to ? short(e.from, true) : `${short(e.from)} – ${short(e.to, true)}`);
    if (e.days) parts.push(`${e.days} дни`);
    if (e.rows != null) parts.push(`${e.rows} реда`);
    if (e.amount != null) parts.push(m(e.amount));
    parts.push(`${(e.ms / 1000).toLocaleString("bg-BG", { maximumFractionDigits: 1 })} с`);
    what = `<span class="tag">база${e.trigger === "manual" ? " · ръчно" : ""}</span>${esc(parts.join(" · "))}${e.error ? `<div class="err">${esc(e.error)}</div>` : ""}`;
  } else what = `<span class="tag">промяна</span>${esc(e.text)}`;
  return `<tr><td class="time">${time}</td><td class="user">${user}</td><td>${what}</td></tr>`;
}
