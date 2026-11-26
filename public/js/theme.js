// Тема: светла/тъмна. Зарежда се в <head>, за да няма премигване.

// ------------------------------------------------------------ Тема
// Изборът се пази на устройството; докато няма избор, темата следва системата
function setTheme(theme) {
  localStorage.setItem("theme", theme);
  applyTheme();
}
function applyTheme() {
  const saved = localStorage.getItem("theme");
  const dark = saved ? saved === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  const b = document.getElementById("themeBtn");
  if (b) { b.textContent = dark ? "☀" : "☾"; b.title = dark ? "Светла тема" : "Тъмна тема"; b.setAttribute("aria-label", b.title); }
}
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);
applyTheme();
