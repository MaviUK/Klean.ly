import { providers, sanitiseSetup, requiredProviderIds } from "./catalog.mjs";

const STORAGE_KEY = "kleanly_business_setup_draft_v1";
const STEP_COUNT = 4;
let step = 0;
let draft = { name: "", domain: "", logoUrl: "", primaryColor: "#059669", desiredProviders: [...requiredProviderIds] };

function byId(id) { return document.getElementById(id); }
function setText(id, value) { byId(id).textContent = value; }
function readDraft() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    if (!stored || typeof stored !== "object") return;
    const safe = sanitiseSetup(stored);
    draft = { ...safe.company, desiredProviders: [...new Set([...requiredProviderIds, ...safe.desiredProviders])] };
  } catch {
    // Bad storage should never block setup.
  }
}
function persistDraft() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(draft)); } catch { /* storage can be unavailable */ }
}
function safeHostname(value) {
  if (!value) return true;
  return /^(?=.{1,253}$)(?!-)[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(value)
    && !value.split(".").some((part) => part.length > 63 || part.startsWith("-") || part.endsWith("-"));
}
function validIdentity() {
  if (!draft.name.trim()) return "Please enter a business name.";
  if (!safeHostname(draft.domain)) return "Enter a valid hostname, such as portal.example.com.";
  if (draft.logoUrl && !/^https:\/\/\S+$/i.test(draft.logoUrl)) return "Logo URL must start with https://.";
  return "";
}
function updatePreview() {
  setText("preview-name", draft.name.trim() || "Your company");
  setText("preview-mark", (draft.name.trim().charAt(0) || "Y").toUpperCase());
  document.documentElement.style.setProperty("--tenant-color", draft.primaryColor);
  setText("colour-output", draft.primaryColor.toUpperCase());
}
}
function renderProvider(provider, required) {
  const card = document.createElement("article");
  card.className = "provider-card";
  const top = document.createElement("div");
  top.className = "provider-top";
  const icon = document.createElement("div");
  icon.className = "provider-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = provider.name.charAt(0);
  const status = document.createElement("span");
  status.className = "provider-status";
  status.textContent = "Not connected";
  top.append(icon, status);
  const heading = document.createElement("h2");
  heading.textContent = provider.name;
  const description = document.createElement("p");
  description.textContent = provider.description;
  const detail = document.createElement("div");
  detail.className = "provider-detail";
  detail.textContent = provider.status + ". " + provider.secret;
  const bottom = document.createElement("div");
  bottom.className = "provider-bottom";
  if (provider.link) {
    const link = document.createElement("a");
    link.href = provider.link;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Open provider ↗";
    bottom.append(link);
  } else {
    const label = document.createElement("span");
    label.textContent = "Device pairing planned";
    label.className = "required-flag";
    bottom.append(label);
  }
  if (required) {
    const flag = document.createElement("span");
    flag.className = "required-flag";
    flag.textContent = "REQUIRED";
    bottom.append(flag);
  } else {
    const label = document.createElement("label");
    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = draft.desiredProviders.includes(provider.id);
    check.setAttribute("aria-label", "Include " + provider.name + " in installation");
    check.addEventListener("change", () => {
      draft.desiredProviders = check.checked
        ? [...new Set([...draft.desiredProviders, provider.id])]
        : draft.desiredProviders.filter((id) => id !== provider.id);
      persistDraft();
    });
    label.append(check, document.createTextNode("Include"));
    bottom.append(label);
  }
  card.append(top, heading, description, detail, bottom);
  return card;
}
function renderProviders() {
  const infra = byId("infrastructure-list");
  const integrations = byId("integration-list");
  infra.replaceChildren(...providers.filter((p) => p.category === "Infrastructure").map((p) => renderProvider(p, true)));
  integrations.replaceChildren(...providers.filter((p) => p.category !== "Infrastructure").map((p) => renderProvider(p, p.required)));
}
function renderSummary() {
  setText("summary-name", draft.name.trim() || "—");
  setText("summary-domain", draft.domain || "Not yet set");
  const optional = providers.filter((p) => !p.required && draft.desiredProviders.includes(p.id));
  const active = providers.filter((p) => p.required && p.category !== "Infrastructure").concat(optional);
  setText("summary-integrations", active.map((p) => p.name).join(", ") || "None");
}
function goTo(next) {
  if (step === 0 && next > 0) {
    const error = validIdentity();
    setText("identity-error", error);
    if (error) { byId("business-name").focus(); return; }
  }
  step = Math.min(STEP_COUNT - 1, Math.max(0, next));
  document.querySelectorAll("[data-view]").forEach((view) => { view.hidden = Number(view.dataset.view) !== step; });
  document.querySelectorAll("[data-step]").forEach((button) => {
    const active = Number(button.dataset.step) === step;
    button.classList.toggle("active", active);
    button.setAttribute("aria-current", active ? "step" : "false");
  });
  setText("progress-text", String(step + 1) + " OF " + STEP_COUNT);
  byId("progress-bar").style.width = String((step + 1) * 25) + "%";
  byId("previous-step").disabled = step === 0;
  const nextButton = byId("next-step");
  nextButton.textContent = step === STEP_COUNT - 1 ? "Return to first step ↺" : "Continue →";
  renderProviders();
  renderSummary();
  window.scrollTo({ top: 0, behavior: "instant" });
}
function downloadManifest() {
  const safe = sanitiseSetup(draft);
  if (!safe.company.name) { goTo(0); setText("identity-error", "Enter a business name first."); return; }
  safe.desiredProviders = [...new Set([...requiredProviderIds, ...safe.desiredProviders])];
  safe.important = "Planning file only. Does not contain API keys or connected accounts.";
  const json = JSON.stringify(safe, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "kleanly-business-installation-blueprint.json";
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

readDraft();
const identityForm = byId("identity-form");
const initialInputs = { name: "business-name", domain: "business-domain", logoUrl: "business-logo", primaryColor: "business-colour" };
for (const [key, id] of Object.entries(initialInputs)) {
  byId(id).value = draft[key] ?? "";
  byId(id).addEventListener("input", () => {
    const value = byId(id).value;
    draft[key] = (key === "domain" ? value.toLowerCase() : value);
    setText("identity-error", "");
    persistDraft();
    updatePreview();
  });
}
identityForm.addEventListener("submit", (event) => { event.preventDefault(); goTo(1); });
byId("next-step").addEventListener("click", () => goTo(step === STEP_COUNT - 1 ? 0 : step + 1));
byId("previous-step").addEventListener("click", () => goTo(step - 1));
document.querySelectorAll("[data-step]").forEach((button) => {
  button.addEventListener("click", () => goTo(Number(button.dataset.step)));
});
byId("download-manifest").addEventListener("click", downloadManifest);
updatePreview();
goTo(0);
