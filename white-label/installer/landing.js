/* Public-facing staging homepage: progress lives in ./progress.json.
   OAuth callback query parameters must continue to open the setup wizard. */
(() => {
  const home = document.getElementById("landing-home");
  const wizard = document.getElementById("setup-wizard");
  if (!home || !wizard) return;

  const query = new URLSearchParams(window.location.search);
  const returningFromOAuth = query.has("supabase_test") || query.has("netlify_result");
  if (returningFromOAuth && window.location.hash !== "#setup") {
    window.history.replaceState({}, "", window.location.pathname + window.location.search + "#setup");
  }

  function showView() {
    const params = new URLSearchParams(window.location.search);
    const setup = window.location.hash === "#setup" ||
      params.get("setup") === "1" ||
      params.has("supabase_test") ||
      params.has("netlify_result");
    home.hidden = setup;
    wizard.hidden = !setup;
    document.title = setup ? "Klean.ly Business — Setup Studio" : "Klean.ly Business — Cleaning business management, your way";
  }
  showView();
  window.addEventListener("hashchange", showView);
  window.addEventListener("popstate", showView);

  const byId = (id) => document.getElementById(id);
  const validPercent = (value) => Number.isInteger(value) && value >= 0 && value <= 100;
  const formattedDate = (iso) => {
    const date = new Date(iso + "T12:00:00Z");
    return Number.isNaN(date.getTime()) ? iso :
      date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  };

  function setMetric(id, percent) {
    const number = byId(id + "-value");
    const ring = byId(id + "-ring");
    if (number) number.textContent = percent + "%";
    if (ring) {
      ring.style.setProperty("--percent", String(percent));
      ring.setAttribute("aria-valuenow", String(percent));
    }
  }

  function renderComponents(items) {
    const target = byId("build-components");
    if (!target || !Array.isArray(items)) return;
    target.replaceChildren();
    for (const item of items) {
      if (!item || typeof item.name !== "string" || !validPercent(item.percent)) continue;
      const row = document.createElement("div");
      row.className = "build-component";
      const heading = document.createElement("div");
      heading.className = "component-heading";
      const label = document.createElement("span");
      label.textContent = item.name;
      const value = document.createElement("strong");
      value.textContent = item.percent + "%";
      heading.append(label, value);
      const track = document.createElement("div");
      track.className = "component-track";
      track.setAttribute("role", "progressbar");
      track.setAttribute("aria-label", item.name);
      track.setAttribute("aria-valuemin", "0");
      track.setAttribute("aria-valuemax", "100");
      track.setAttribute("aria-valuenow", String(item.percent));
      const fill = document.createElement("span");
      fill.className = "component-fill";
      fill.style.width = item.percent + "%";
      track.append(fill);
      row.append(heading, track);
      target.append(row);
    }
  }

  function renderUpdates(items) {
    const target = byId("build-updates");
    if (!target || !Array.isArray(items)) return;
    target.replaceChildren();
    for (const item of items.slice(0, 3)) {
      if (!item || typeof item.title !== "string" || typeof item.date !== "string") continue;
      const row = document.createElement("article");
      row.className = "update-row";
      const date = document.createElement("time");
      date.dateTime = item.date;
      date.textContent = formattedDate(item.date);
      const content = document.createElement("div");
      const title = document.createElement("h4");
      title.textContent = item.title;
      const detail = document.createElement("p");
      detail.textContent = typeof item.detail === "string" ? item.detail : "";
      content.append(title, detail);
      const tag = document.createElement("span");
      tag.className = "update-state";
      tag.textContent = typeof item.status === "string" ? item.status : "Update";
      row.append(date, content, tag);
      target.append(row);
    }
  }

  async function loadProgress() {
    if (home.hidden) return;
    try {
      const result = await fetch("./progress.json?t=" + Date.now(), { cache: "no-store" });
      if (!result.ok) throw new Error("Progress unavailable");
      const data = await result.json();
      if (data.schemaVersion !== 1 ||
          !validPercent(data.overall) ||
          !validPercent(data.firstInstallation) ||
          !Array.isArray(data.components)) throw new Error("Invalid progress data");
      setMetric("overall", data.overall);
      setMetric("pilot", data.firstInstallation);
      renderComponents(data.components);
      renderUpdates(data.updates);
      for (const element of document.querySelectorAll("[data-progress-date]")) {
        element.textContent = formattedDate(data.asOf);
      }
      for (const element of document.querySelectorAll("[data-next-milestone]")) {
        element.textContent = data.nextMilestone || "Further CRM development";
      }
      const status = byId("build-status");
      if (status) status.textContent = data.status || "In development";
      const note = byId("estimate-note");
      if (note) note.textContent = data.estimateNote || "";
      const source = byId("progress-source");
      if (source) source.textContent = "Latest published project estimate";
    } catch {
      const source = byId("progress-source");
      if (source) source.textContent = "Showing last published snapshot";
      /* The initial HTML contains safe fallback percentages when offline. */
    }
  }

  loadProgress();
  window.setInterval(loadProgress, 120000);
  window.addEventListener("hashchange", loadProgress);
})();
