// ============================================================================
//  app.js — entry point. Nav, theme, auth gate, boot. Mounts feature modules.
// ============================================================================
import { supa, resolveHousehold, loadAll, seedIfEmpty } from "./store.js";
import { mountFinances } from "./finances.js";
import { mountProjects } from "./projects.js";
import { mountProjectDetail, showProjectDetail } from "./project-detail.js";
import { mountForecast } from "./forecast.js";
import { mountSpending } from "./spending.js";
import { mountHome } from "./home.js";
import { mountReports } from "./reports.js";
import { mountMerchants } from "./merchants.js";
import { mountAnalysis } from "./analysis.js";
import { mountCategoriesPage } from "./categories-page.js";
import { mountSettings } from "./settings.js";
import { APP_VERSION, BUILD_DATE } from "./version.js";

console.log(`HouseholdOS Planner v${APP_VERSION} (built ${BUILD_DATE})`);

/* ---- Nav ----
   One definition drives the desktop sidebar, the mobile bottom nav, AND the
   mobile "More" drawer. Pages are grouped by mental mode; the three "pillar"
   views (Forecast/Spending/Projects) plus Home get permanent bottom-nav slots.
   Settings isn't a screen — it opens the gear sheet (action:"settings"). */
const NAV = [
  { id: "home",      label: "Home",      icon: "home",         group: "Home"   },
  { id: "forecast",  label: "Forecast",  icon: "line-chart",   group: "Plan"   },
  { id: "projects",  label: "Projects",  icon: "hammer",       group: "Plan"   },
  { id: "spending",  label: "Spending",  icon: "receipt",      group: "Spend"  },
  { id: "reports",   label: "Reports",   icon: "bar-chart-3",  group: "Spend"  },
  { id: "analysis",  label: "Analysis",  icon: "scan-search",  group: "Spend"  },
  { id: "merchants", label: "Merchants", icon: "store",        group: "Spend"  },
  { id: "finances",   label: "Finances",   icon: "wallet",     group: "Set up" },
  { id: "categories", label: "Categories", icon: "tags",       group: "Set up" },
  { id: "settings",   label: "Settings",   icon: "settings",   group: "Set up" },
];
const GROUPS = ["Home", "Plan", "Spend", "Set up"];
const BOTTOM = ["home", "forecast", "spending", "projects"]; // + a "More" button

const itemHtml = (t) => `<i data-lucide="${t.icon}"></i><span>${t.label}</span>`;

// Grouped list — used by both the desktop sidebar and the mobile More drawer.
function renderGrouped(host) {
  host.innerHTML = "";
  let first = true;
  for (const g of GROUPS) {
    const items = NAV.filter((n) => n.group === g);
    if (!items.length) continue;
    if (g !== "Home") {
      const h = document.createElement("div");
      h.className = "nav-group" + (first ? " first" : "");
      h.textContent = g;
      host.appendChild(h);
    }
    first = false;
    for (const t of items) {
      const n = document.createElement("div");
      n.className = "navitem"; n.dataset.nav = t.id;
      n.innerHTML = itemHtml(t);
      n.onclick = () => onNav(t.id);
      host.appendChild(n);
    }
  }
}

function renderBottom(host) {
  host.innerHTML = "";
  for (const id of BOTTOM) {
    const t = NAV.find((n) => n.id === id);
    const n = document.createElement("div");
    n.className = "bnitem"; n.dataset.nav = id;
    n.innerHTML = itemHtml(t);
    n.onclick = () => onNav(id);
    host.appendChild(n);
  }
  const more = document.createElement("div");
  more.className = "bnitem"; more.dataset.nav = "more";
  more.innerHTML = `<i data-lucide="menu"></i><span>More</span>`;
  more.onclick = openDrawer;
  host.appendChild(more);
}

function buildNav() {
  renderGrouped(document.getElementById("sidebar"));
  renderGrouped(document.getElementById("drawer-list"));
  renderBottom(document.getElementById("bottomnav"));
  document.querySelector("#moredrawer .drawer-veil").onclick = closeDrawer;
  lucide.createIcons();
}

// A nav tap — route via the hash.
function onNav(id) {
  closeDrawer();
  location.hash = "#/" + id;
}

/* ---- Router (hash-based) ----
   Top-level views today; the sub-route slot (#/projects/:id) is where the
   project detail page will hang in the next step. Back button works for free
   because each nav pushes a hash entry. */
function currentRoute() {
  const h = location.hash.replace(/^#\/?/, "");
  const [view, id] = h.split("/");
  return { view: view || "home", id: id || null };
}
function applyRoute() {
  const { view, id } = currentRoute();
  const isProjDetail = view === "projects" && id;
  const known = NAV.some((n) => n.id === view);
  const base = known ? view : "home";
  const screen = isProjDetail ? "project-detail" : base;
  const navActive = isProjDetail ? "projects" : base;
  document.querySelectorAll(".screen").forEach((s) =>
    s.classList.toggle("active", s.dataset.screen === screen));
  document.querySelectorAll("[data-nav]").forEach((n) => {
    const on = n.dataset.nav === navActive || (n.dataset.nav === "more" && !BOTTOM.includes(navActive));
    n.classList.toggle("active", on);
  });
  if (isProjDetail) showProjectDetail(id);
  lucide.createIcons();
}
window.addEventListener("hashchange", applyRoute);

/* ---- More drawer (mobile) ---- */
function openDrawer() {
  const d = document.getElementById("moredrawer");
  d.hidden = false;
  requestAnimationFrame(() => d.classList.add("open"));
}
function closeDrawer() {
  const d = document.getElementById("moredrawer");
  if (d.hidden) return;
  d.classList.remove("open");
  setTimeout(() => { d.hidden = true; }, 240);
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
      mountHome();
      mountForecast();
      mountSpending();
      mountFinances();
      mountProjects();
      mountProjectDetail();
      mountReports();
      mountMerchants();
      mountAnalysis();
      mountCategoriesPage();
      mountSettings();
      applyRoute();         // land on the hash (defaults to Home)
    }
  } else {
    gate.style.display = "grid";
    app.hidden = true;
  }
}

/* ---- Service worker (offline + installable) ----
   Register as sw.js?v=<version> so a version bump = a new SW = fresh cache.
   When a NEW sw takes control (update after a deploy), reload once so the
   latest assets load. Skip the reload on first-ever install (no prior
   controller) to avoid a needless refresh on first visit. */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register("sw.js?v=" + APP_VERSION).catch(() => {});
    let reloaded = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!hadController || reloaded) return;
      reloaded = true;
      window.location.reload();
    });
  });
}

/* ---- Boot ---- */
buildNav();
const { data: { session } } = await supa.auth.getSession();
onSession(session);
supa.auth.onAuthStateChange((_evt, s) => onSession(s));
