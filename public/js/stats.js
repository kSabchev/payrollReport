// Раздел Статистика: суми със сравнения, графики (SVG, без библиотеки), най-продавани, магазини.
// Цветовете на колоните са същите като в таблицата Приходи (colColor). Всяка стойност от
// графиките е и в таблицата „Таблица с данните“ — подсказките само помагат, не са единственият път.

let statsData = null, statsSeq = 0;
const compact = new Intl.NumberFormat("bg-BG", { notation: "compact", maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat("bg-BG", { maximumFractionDigits: 0 });
const MONTHS_SHORT = ["яну", "фев", "мар", "апр", "май", "юни", "юли", "авг", "сеп", "окт", "ное", "дек"];
const WD_LONG = ["неделя", "понеделник", "вторник", "сряда", "четвъртък", "петък", "събота"];

function statsFrame() {
  tip.hidden = true;
  // Докато се зареждат новите данни, старите графики остават, но по-бледи
  return `<div class="stats${statsData ? " loading" : ""}" id="stats">${statsData ? statsHtml(statsData) : `<p class="muted">Зареждане…</p>`}</div>`;
}

async function loadStats() {
  const p = period(), seq = ++statsSeq;
  try {
    const r = await api(`/api/stats?from=${p.from}&to=${p.to}&store=${S.store}`);
    if (seq !== statsSeq) return;
    statsData = r;
    if (r.db) S.meta.db = r.db;
  } catch (e) {
    if (seq === statsSeq && $("#stats")) $("#stats").innerHTML = `<div class="notice">${esc(e.message)}</div>`;
    return;
  }
  if (S.tab === "stats" && $("#stats")) { tip.hidden = true; $("#stats").classList.remove("loading"); $("#stats").innerHTML = statsHtml(statsData); renderAlerts(); }
}

// Прерисуване при смяна на ширината (графиките се мерят по ширината на картата)
let statsResize = 0;
window.addEventListener("resize", () => {
  clearTimeout(statsResize);
  statsResize = setTimeout(() => { if (S.tab === "stats" && statsData && $("#stats")) $("#stats").innerHTML = statsHtml(statsData); }, 150);
});

// ------------------------------------------------------------ Части
const range = (a, b) => (a === b ? short(a, true) : `${short(a, a.slice(0, 4) !== b.slice(0, 4))} – ${short(b, true)}`);
const bucketLabel = (s, key, long) => {
  if (s.byDay) { const d = parse(key); return long ? `${WD[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}` : String(d.getDate()); }
  const [y, mo] = key.split("-").map(Number);
  return long ? `${cap(MONTHS[mo - 1])} ${y}` : MONTHS_SHORT[mo - 1] + (s.from.slice(0, 4) !== s.to.slice(0, 4) ? ` ${String(y).slice(2)}` : "");
};

// Промяна спрямо друг период: стрелка + процент + с какво се сравнява (не само цвят)
function delta(cur, prev, upIsGood, label) {
  if (!prev) return `<div class="delta">— ${esc(label)}</div>`;
  const pct = ((cur - prev) / Math.abs(prev)) * 100;
  const up = pct >= 0, good = up === upIsGood;
  const p = Math.abs(pct) < 0.05 ? "0%" : `${up ? "▲" : "▼"} ${Math.abs(pct).toLocaleString("bg-BG", { maximumFractionDigits: 1 })}%`;
  return `<div class="delta"><b class="${Math.abs(pct) < 0.05 ? "" : good ? "good" : "bad"}">${p}</b> ${esc(label)}</div>`;
}

function kpis(s) {
  // При цяла година предишният период е миналата година — показва се веднъж
  const sameAsLastYear = s.prev.from === s.lastYear.from && s.prev.to === s.lastYear.to;
  const cmp = (k, upGood) => delta(s.current[k], s.prev[k], upGood, `спрямо ${range(s.prev.from, s.prev.to)}`) +
    (sameAsLastYear ? "" : delta(s.current[k], s.lastYear[k], upGood, `спрямо ${range(s.lastYear.from, s.lastYear.to)}`));
  const tile = (label, k, upGood) => `<div class="kpi"><div class="label">${label}</div><div class="value">${m(s.current[k])}</div>${cmp(k, upGood)}</div>`;
  return `<div class="kpis">${tile("Приходи", "revenue", true)}${tile("Разходи", "expenses", false)}${tile("Приходи − разходи", "profit", true)}</div>`;
}

// Кръгли стойности за оста (0, 2 000, 4 000 …)
function niceTicks(min, max, count = 4) {
  if (max === min) max = min + 1;
  const raw = (max - min) / count, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((v) => v >= raw);
  const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
  const out = [];
  for (let v = lo; v <= hi + step / 2; v += step) out.push(Math.round(v * 100) / 100);
  return out;
}
const axisFmt = (v, max) => (Math.abs(max) >= 10000 ? compact.format(v) : whole.format(v));

// Правоъгълник със заоблен край само откъм стойността (4px); основата остава права
function bar(x, y, w, h, up = true, r = 4) {
  if (h <= 0) return "";
  r = Math.min(r, h, w / 2);
  return up
    ? `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`
    : `M${x},${y}V${y + h - r}Q${x},${y + h} ${x + r},${y + h}H${x + w - r}Q${x + w},${y + h} ${x + w},${y + h - r}V${y}Z`;
}

// Колонна графика: stacked (няколко серии една върху друга) или една серия с положителни и отрицателни стойности
function columnChart({ W, H = 240, s, items, series, valueOf, colorOf, tipOf }) {
  const L = 52, R = 8, T = 10, B = 24, pw = W - L - R, ph = H - T - B;
  const totals = items.map((it) => series.reduce((a, se) => a + Math.max(0, valueOf(it, se)), 0));
  const negs = items.map((it) => series.reduce((a, se) => a + Math.min(0, valueOf(it, se)), 0));
  const ticks = niceTicks(Math.min(0, ...negs), Math.max(0, ...totals));
  const lo = ticks[0], hi = ticks[ticks.length - 1], y = (v) => T + ph - ((v - lo) / (hi - lo)) * ph;
  const slot = pw / items.length, bw = Math.max(2, Math.min(24, slot * 0.7));
  const every = Math.max(1, Math.ceil(items.length / Math.max(1, Math.floor(pw / 34))));
  let out = ticks.map((t) => `<line class="${t === 0 ? "base" : "grid"}" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/>` +
    `<text x="${L - 6}" y="${y(t) + 4}" text-anchor="end">${axisFmt(t, hi)}</text>`).join("");
  items.forEach((it, i) => {
    const x = L + i * slot + (slot - bw) / 2;
    // Частите се редят от нулата навън; само последната (крайната) е заоблена,
    // а между частите остава 2px разстояние в цвета на фона
    let up = y(0), down = y(0), segs = "";
    const vals = series.map((se) => ({ se, v: valueOf(it, se) })).filter((o) => o.v);
    const pos = vals.filter((o) => o.v > 0), neg = vals.filter((o) => o.v < 0);
    pos.forEach(({ se, v }, k) => {
      const h = y(0) - y(v), top = up - h, last = k === pos.length - 1;
      const d = last ? bar(x, top, bw, h, true) : h > 2 ? `M${x},${top + 2}h${bw}v${h - 2}h${-bw}Z` : "";
      segs += `<path class="seg" fill="${colorOf(se, v)}" d="${d}"/>`;
      up = top;
    });
    neg.forEach(({ se, v }, k) => {
      const h = y(v) - y(0), last = k === neg.length - 1;
      const d = last ? bar(x, down, bw, h, false) : h > 2 ? `M${x},${down}h${bw}v${h - 2}h${-bw}Z` : "";
      segs += `<path class="seg" fill="${colorOf(se, v)}" d="${d}"/>`;
      down += h;
    });
    const label = i % every === 0 ? `<text x="${L + i * slot + slot / 2}" y="${H - 6}" text-anchor="middle">${esc(bucketLabel(s, it.key))}</text>` : "";
    out += `<g class="mark${it.future ? " future" : ""}" tabindex="0" data-tip="${esc(tipOf(it))}">${segs}` +
      `<rect class="hit" x="${L + i * slot}" y="${T}" width="${slot}" height="${ph}"/></g>${label}`;
  });
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img">${out}</svg>`;
}
// Хоризонтални ленти с етикет вляво и стойност на края
function barList({ W, rows, color }) {
  const L = 92, R = 70, rowH = 26, H = rows.length * rowH + 4, max = Math.max(...rows.map((r) => r.value), 1);
  const out = rows.map((r, i) => {
    const w = ((W - L - R) * r.value) / max, yy = 4 + i * rowH;
    return `<g class="mark" tabindex="0" data-tip="${esc(r.tip)}"><text x="${L - 8}" y="${yy + 15}" text-anchor="end">${esc(r.label)}</text>` +
      `<path class="seg" fill="${color}" d="${w > 0 ? `M${L},${yy + 5}H${L + w - Math.min(4, w)}Q${L + w},${yy + 5} ${L + w},${yy + 5 + Math.min(4, w)}V${yy + 19 - Math.min(4, w)}Q${L + w},${yy + 19} ${L + w - Math.min(4, w)},${yy + 19}H${L}Z` : ""}"/>` +
      `<text class="val" x="${L + w + 6}" y="${yy + 15}">${esc(r.text)}</text><rect class="hit" x="0" y="${yy}" width="${W}" height="${rowH}"/></g>`;
  }).join("");
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img">${out}</svg>`;
}

// ------------------------------------------------------------ Страницата
function statsHtml(s) {
  // Ширина на графиките: картата е широка колкото раздела без отстъпите; на тесен екран — една колона
  const el = $("#stats"), W = Math.max(300, Math.floor((el?.clientWidth || 900) - 32 - 30));
  const half = innerWidth > 860 ? Math.floor((W - 16) / 2) : W;
  const cols = revCols(), color = (c) => colColor(c);
  const notice = s.syncError && !(S.meta.db && !S.meta.db.ok) ? `<div class="notice" style="margin:0 0 12px">${esc(s.syncError)} Показват се запазените данни.</div>` : "";
  const clipped = s.current.to < s.to ? ` (до днес, ${short(s.current.to, true)})` : "";
  const sub = `${range(s.from, s.to)}${clipped}${readOnly() ? " · всички магазини" : multiStore() ? ` · ${storeName(S.store)}` : ""}`;

  // Приходи по колони във времето
  const tipRev = (it) => `${bucketLabel(s, it.key, true)}\nОбщо: ${m(it.revenue)}\n` + cols.map((c) => `${c.name}: ${m(it.byColumn[c.id])}`).join("\n");
  const revChart = columnChart({ W, s, items: s.series, series: cols, valueOf: (it, c) => it.byColumn[c.id] || 0, colorOf: color, tipOf: tipRev });
  const legend = `<div class="legend">${cols.map((c) => `<span><i style="background:${color(c)}"></i>${esc(c.name)}</span>`).join("")}</div>`;

  // Печалба по дни/месеци (над нулата — печалба, под — загуба)
  const tipProfit = (it) => `${bucketLabel(s, it.key, true)}\nПриходи − разходи: ${m(it.profit)}\nПриходи: ${m(it.revenue)}\nРазходи: ${m(it.expenses)}`;
  const profitChart = columnChart({ W: half, H: 200, s, items: s.series, series: [{ id: "p" }], valueOf: (it) => it.profit,
    colorOf: (_, v) => (v < 0 ? "var(--exp)" : "var(--rev)"), tipOf: tipProfit });

  // Средно на ден по дни от седмицата
  const best = [...s.weekdays].sort((a, b) => b.avg - a.avg)[0];
  const wdChart = barList({ W: half, color: "var(--accent)", rows: s.weekdays.map((w) => ({ label: cap(WD_LONG[w.weekday]), value: w.avg, text: compact.format(w.avg),
    tip: `${cap(WD_LONG[w.weekday])}\nСредно на ден: ${m(w.avg)}\nОбщо: ${m(w.revenue)} за ${w.days} дни` })) });

  // Най-продавани
  const maxTop = Math.max(...s.topItems.map((t) => t.amount), 1);
  const colOf = (id) => cols.find((c) => c.id === id);
  const top = s.topError ? `<p class="err">${esc(s.topError)}</p>` : !s.topItems.length ? `<p class="muted">Няма продажби за периода.</p>` :
    `<table class="toplist"><thead><tr><th class="name">Артикул</th><th>К-во</th><th>Сума</th><th class="barcell"></th></tr></thead><tbody>
      ${s.topItems.map((t) => { const c = colOf(t.col); return `<tr><td class="name"><span class="dot" style="background:${c ? color(c) : "var(--muted)"}"></span>${esc(t.name)}
        <span class="muted">${esc(c?.name ?? "")}</span></td><td>${qfmt.format(t.qtty)}</td><td>${m(t.amount)}</td>
        <td class="barcell"><div class="bar" style="width:${(t.amount / maxTop) * 100}%;background:${c ? color(c) : "var(--muted)"}"></div></td></tr>`; }).join("")}
    </tbody></table>`;

  // Магазините един до друг
  const stores = s.stores.length ? `<div class="card wide"><h3>Магазини</h3><p class="sub">Приходи, разходи и разликата за ${range(s.from, s.current.to)}</p>
    <table class="toplist"><thead><tr><th class="name">Магазин</th><th>Приходи</th><th>Разходи</th><th>Приходи − разходи</th><th class="barcell"></th></tr></thead><tbody>
    ${(() => { const mx = Math.max(...s.stores.map((x) => x.revenue), 1); return s.stores.map((x) => `<tr><td class="name">${esc(x.name)}</td>
      <td>${m(x.revenue)}</td><td>${m(x.expenses)}</td><td class="${x.profit < 0 ? "neg" : ""}">${m(x.profit)}</td>
      <td class="barcell"><div class="bar" style="width:${(x.revenue / mx) * 100}%;background:var(--accent)"></div></td></tr>`).join(""); })()}
    </tbody></table></div>` : "";

  // Таблица с всички стойности от графиките
  const table = `<details><summary>Таблица с данните</summary><div class="tablewrap" style="max-height:none;border-top:1px solid var(--line);border-radius:10px;margin-top:8px">
    <table class="grid"><thead><tr><th>${s.byDay ? "Ден" : "Месец"}</th>${cols.map((c) => `<th>${esc(c.name)}</th>`).join("")}<th>Приходи</th><th>Разходи</th><th>Приходи − разходи</th></tr></thead>
    <tbody>${s.series.map((it) => `<tr><th>${esc(bucketLabel(s, it.key, true))}</th>${cols.map((c) => `<td><span class="v">${mOrBlank(it.byColumn[c.id])}</span></td>`).join("")}
      <td class="total"><span class="v">${m(it.revenue)}</span></td><td><span class="v">${m(it.expenses)}</span></td><td class="${it.profit < 0 ? "bal-neg" : ""}"><span class="v">${m(it.profit)}</span></td></tr>`).join("")}</tbody>
    </table></div></details>`;

  return `${notice}<h3>Статистика</h3><p class="sub">${esc(sub)}</p>${kpis(s)}
    <div class="charts">
      <div class="card wide"><h3>Приходи по колони</h3><p class="sub">${s.byDay ? "По дни" : "По месеци"}. Посочете колона за подробности.</p>${legend}${revChart}</div>
      <div class="card"><h3>Приходи − разходи</h3><p class="sub">${s.byDay ? "По дни" : "По месеци"}. Над нулата — печалба, под нулата — загуба.</p>${profitChart}</div>
      <div class="card"><h3>Средно на ден по дни от седмицата</h3><p class="sub">${best?.avg ? `Най-силен ден: ${WD_LONG[best.weekday]}` : "Няма продажби за периода"}</p>${wdChart}</div>
      <div class="card wide"><h3>Най-продавани артикули</h3><p class="sub">По сума за ${range(s.from, s.current.to)}</p>${top}</div>
      ${stores}
    </div>${table}`;
}

// ------------------------------------------------------------ Подсказка при посочване или фокус
const tip = document.createElement("div");
tip.className = "tip"; tip.hidden = true;
document.addEventListener("DOMContentLoaded", () => document.body.append(tip));
function showTip(text, x, y) {
  tip.textContent = text; // текстът е от данните — само като текст, не HTML
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  tip.style.left = Math.min(innerWidth - r.width - 8, x + 14) + "px";
  tip.style.top = Math.max(8, y - r.height - 10) + "px";
}
document.addEventListener("pointermove", (e) => {
  const t = e.target.closest?.("[data-tip]");
  if (t) showTip(t.dataset.tip, e.clientX, e.clientY); else tip.hidden = true;
});
document.addEventListener("focusin", (e) => {
  const t = e.target.closest?.("[data-tip]");
  if (!t) { tip.hidden = true; return; }
  const r = t.getBoundingClientRect();
  showTip(t.dataset.tip, r.left + r.width / 2, r.top);
});
document.addEventListener("focusout", () => { tip.hidden = true; });
