// Вход и акаунти

// ------------------------------------------------------------ Вход и акаунти
// setup = още няма акаунти: създава се първият
function showAuth(setup) {
  if (dlg.open) dlg.close();
  document.querySelector("main").hidden = true;
  const box = $("#auth");
  box.hidden = false;
  box.innerHTML = `<form class="authbox" id="authForm">
    <h1>${setup ? "Първи акаунт" : "Вход"}</h1>
    ${setup ? `<p class="muted" style="margin:0">Още няма акаунти. Създайте администратор; другите акаунти се добавят после от Настройки.</p>` : ""}
    <label for="aUser">Име</label><input class="field" id="aUser" autocomplete="username" autocapitalize="none" required>
    <label for="aPass">Парола</label><input class="field" id="aPass" type="password" autocomplete="${setup ? "new-password" : "current-password"}" required>
    ${setup ? `<label for="aPass2">Паролата отново</label><input class="field" id="aPass2" type="password" autocomplete="new-password" required>` : ""}
    <p class="err" id="aErr" style="margin:10px 0 0"></p>
    <button class="primary">${setup ? "Създай и влез" : "Влез"}</button>
  </form>`;
  $("#aUser").focus();
  $("#authForm").onsubmit = async (e) => {
    e.preventDefault();
    const username = $("#aUser").value, password = $("#aPass").value;
    if (setup && password !== $("#aPass2").value) { $("#aErr").textContent = "Паролите не съвпадат"; return; }
    try { await api(setup ? "/api/setup" : "/api/login", { username, password }); location.reload(); }
    catch (err) { $("#aErr").textContent = err.message; $("#aPass").select(); }
  };
}

function usersView(a) {
  const when = (s) => (s ? new Date(s).toLocaleString("bg-BG", { dateStyle: "short", timeStyle: "short" }) : "—");
  return `<p class="help">Всички акаунти са администратори. Влезли сте като <strong>${esc(a.user?.name)}</strong>.</p>
    <table class="maptable"><thead><tr><th>Име</th><th>Създаден</th><th>Последен вход</th><th></th></tr></thead><tbody>
    ${a.users.map((u) => `<tr><td>${esc(u.username)}${u.username === a.user?.name ? ` <span class="muted">(вие)</span>` : ""}</td>
      <td class="muted">${when(u.createdAt)}</td><td class="muted">${when(u.lastLogin)}</td>
      <td><button class="ghost" data-userpw="${esc(u.username)}">Смени паролата</button>
        ${u.username === a.user?.name ? "" : `<button class="ghost" data-userdel="${esc(u.username)}">Изтрий</button>`}</td></tr>`).join("")}
    </tbody></table>
    <div class="actions" style="justify-content:flex-start;margin-top:8px"><button class="ghost" id="addUser">+ Нов акаунт</button></div>`;
}

// Без име — нов акаунт; с име — нова парола за този акаунт
function openUser(username) {
  const isNew = !username;
  showDialog(`<h2>${isNew ? "Нов акаунт" : `Нова парола за „${esc(username)}“`}</h2>
    <p class="sub">${isNew ? "Новият акаунт също е администратор." : "Акаунтът ще излезе от другите си устройства."}</p>
    ${isNew ? `<div class="row"><input class="field" id="uName" placeholder="Име" autocomplete="off" autocapitalize="none"></div>` : ""}
    <div class="row"><input class="field" id="uPass" type="password" placeholder="Парола (поне 8 знака)" autocomplete="new-password"></div>
    <div class="row"><input class="field" id="uPass2" type="password" placeholder="Паролата отново" autocomplete="new-password"></div>
    <div class="actions"><button class="ghost" id="cancel">Отказ</button><button class="primary" id="ok">${isNew ? "Създай" : "Запази"}</button></div>`, (root) => {
    $("#cancel", root).onclick = closeDialog;
    $("#ok", root).onclick = async () => {
      const password = $("#uPass", root).value;
      if (password !== $("#uPass2", root).value) return alert("Паролите не съвпадат");
      try {
        const r = await api("/api/users", isNew ? { action: "add", username: $("#uName", root).value, password } : { action: "password", username, password });
        S.meta.auth.users = r.users; closeDialog(); render();
      } catch (err) { alert(err.message); }
    };
  });
  setTimeout(() => $(isNew ? "#uName" : "#uPass")?.focus(), 0);
}
