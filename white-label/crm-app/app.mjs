// Klean.ly Business CRM interface prototype v0.1.
// No network requests, Supabase keys, authentication, customer records or writes.
// This static package must NOT be deployed as a functioning CRM.
const pageDetails = Object.freeze({
  dashboard: ["Overview", "Your business, all in one place.",
    "A clean workspace for your customers, rounds, bookings and payments."],
  customers: ["Customers", "Know every customer.",
    "All the details you need for a personal, reliable cleaning service."],
  rounds: ["Cleaning rounds", "Simplify your cleaning rounds.",
    "Plan repeat services by area, day and cleaning interval."],
  jobs: ["Jobs & schedules", "Keep every job on track.",
    "One place to follow scheduled, completed, missed and cancelled visits."],
  payments: ["Payments", "A clearer view of payments.",
    "Keep payment history organised without losing sight of what is outstanding."],
  messages: ["Messages", "Customer conversations, together.",
    "View SMS and email delivery records after providers have been connected."],
  team: ["Team", "Built for your whole team.",
    "Manage secure owner and staff access as your business grows."],
  settings: ["Settings", "Make Klean.ly Business your own.",
    "Company details, branding and settings for your dedicated installation."],
});

const sidebar = document.getElementById("sidebar");
const shade = document.getElementById("menu-shade");
const toggle = document.getElementById("menu-toggle");
const views = [...document.querySelectorAll("[data-view]")];
const buttons = [...document.querySelectorAll("[data-page]")];
const smallScreen = window.matchMedia("(max-width: 800px)");

function closeMenu() {
  sidebar.classList.remove("is-open");
  shade.hidden = true;
  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("aria-label", "Open navigation");
}

function showMenu() {
  if (!smallScreen.matches) return;
  sidebar.classList.add("is-open");
  shade.hidden = false;
  toggle.setAttribute("aria-expanded", "true");
  toggle.setAttribute("aria-label", "Close navigation");
}

function displayPage(value) {
  const page = Object.hasOwn(pageDetails, value) ? value : "dashboard";
  const [label, heading, subheading] = pageDetails[page];
  for (const view of views) view.hidden = view.dataset.view !== page;
  for (const button of buttons) {
    const active = button.dataset.page === page;
    button.classList.toggle("is-active", active && button.classList.contains("menu-button"));
    if (button.classList.contains("menu-button")) {
      if (active) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    }
  }
  document.getElementById("breadcrumb-current").textContent = label;
  document.getElementById("screen-title").textContent = heading;
  document.getElementById("screen-description").textContent = subheading;
  document.title = label + " | Klean.ly Business Preview";
  closeMenu();
}

function pageFromUrl() {
  return decodeURIComponent(window.location.hash.replace(/^#/, ""));
}

for (const button of buttons) {
  button.addEventListener("click", () => {
    const page = button.dataset.page;
    if (!Object.hasOwn(pageDetails, page)) return;
    if (window.location.hash !== "#" + page) {
      window.location.hash = page;
    } else {
      displayPage(page);
    }
    window.scrollTo({ top: 0, behavior: "instant" });
  });
}
toggle.addEventListener("click", () => {
  if (sidebar.classList.contains("is-open")) closeMenu();
  else showMenu();
});
shade.addEventListener("click", closeMenu);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeMenu();
});
smallScreen.addEventListener("change", closeMenu);
window.addEventListener("hashchange", () => displayPage(pageFromUrl()));
displayPage(pageFromUrl());
