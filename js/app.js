// ============================================================================
//  app.js — entry point. Nav, theme, auth gate, boot. Mounts feature modules.
// ============================================================================
import { supa, resolveHousehold, loadAll, seedIfEmpty } from "./store.js";
import { mountFinances } from "./finances.js";
import { mountProjects } from "./projects.js";
import { mountForecast } from "./forecast.js";
import { mountTasks } from "./tasks.js";
import { openSettings } from "./settings.js";

/* ---- Nav ---- */
const TABS = [
  { id: "forecast", label: "Forecast", icon: "line-chart" },
  { id: "projects", label: "Projects", icon: "hammer" },
  { id: "finances", label: "Finances", icon: "wallet" },
  { id: "tasks",    label: "Tasks",    icon: "list-checks" },
];

function buildNav() {
  const side = document.getElementById("sidebar");
  const bot  = document.getElementById("bottomnav");
  side.innerHTML = ""; bot.innerHTML = "";
  for (const t of TABS) {
    for (const [host, cls] of [[side, "navitem"], [bot, "bnitem"]]) {
      const n = document.createElement("div");
      n.className = cls + (t.id === "forecast" ? " active" : "");
      n.dataset.tab = t.id;
      n.innerHTML = `<i data-lucide="${t.icon}"></i><span>${t.label}</span>`;
      n.onclick = () => go(t.id);
      host.appendChild(n);
    }
  }
  lucide.createIcons();
}

function go(tab) {
  document.querySelectorAll(".screen").forEach((s) =>
    s.classList.toggle("active", s.dataset.screen === tab));
  document.querySelectorAll("[data-tab]").forEach((n) =>
    n.classList.toggle("active", n.dataset.tab === tab));
  lucide.createIcons();
}

/* ---- Theme ---- */
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name=theme-color]')
    .setAttribute("content", theme === "dark" ? "#0A0D11" : "#F6F8F6");
  document.getElementById("themeBtn").innerHTML =
    `<i data-lucide="${theme === "dark" ? "moon" : "sun"}"></i>`;
  localStorage.setItem("hp-theme", theme);
  lucide.createIcons();
}
document.getElementById("themeBtn").onclick = () =>
  applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
applyTheme(localStorage.getItem("hp-theme") || "dark");

/* ---- Settings gear ---- */
document.getElementById("gearBtn").onclick = () => openSettings();

/* ---- Auth ---- */
const gate = document.getElementById("gate");
const app  = document.getElementById("app");
const authMsg = document.getElementById("authMsg");
const authBtn = document.getElementById("authBtn");

document.getElementById("authForm").onsubmit = async (e) => {
  e.preventDefault();
  const email = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value;
  if (!email || !password) return;
  authBtn.disabled = true; authMsg.textContent = "Signing in…";
  const { error } = await supa.auth.signInWithPassword({ email, password });
  authBtn.disabled = false;
  authMsg.textContent = error ? error.message : "";
};

document.getElementById("signoutBtn").onclick = () => supa.auth.signOut();

let booted = false;
async function onSession(session) {
  if (session) {
    gate.style.display = "none";
    app.hidden = false;
    if (!booted) {
      booted = true;
      await resolveHousehold();
      await loadAll();      // pull whatever exists
      await seedIfEmpty();  // idempotent placeholders on first open
      mountForecast();
      mountFinances();
      mountProjects();
      mountTasks();
    }
  } else {
    gate.style.display = "grid";
    app.hidden = true;
  }
}

/* ---- Service worker (offline + installable) ---- */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () =>
    navigator.serviceWorker.register("sw.js").catch(() => {}));
}

/* ---- Boot ---- */
buildNav();
const { data: { session } } = await supa.auth.getSession();
onSession(session);
supa.auth.onAuthStateChange((_evt, s) => onSession(s));
