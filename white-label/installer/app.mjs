import { providers, sanitiseSetup, requiredProviderIds } from "./catalog.mjs";

const STORAGE_KEY = "kleanly_business_setup_draft_v1";
const STEP_COUNT = 4;
// Netlify OAuth is provided by the separate infrastructure module.
let step = 0;
let draft = { name: "", domain: "", logoUrl: "", primaryColor: "#059669", desiredProviders: [...requiredProviderIds] };
let oauthState = { configured: false, verified: false, connected: false,
  mode: "verification-only", connection: null, organization: null, identity: null,
  csrfToken: null };
let netlifyState = { configured: false, authenticated: false, connected: false, identity: null, connection: null };

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
  if (provider.id === "supabase") {
    if (oauthState.connected) {
      status.textContent = oauthState.connection?.status === "connected"
        ? "Connected securely" : "Reconnect needed";
      detail.textContent = "Your Supabase grant is encrypted in the separate Klean.ly Business control-plane database. All project and company data remains in your own Supabase. No project has been installed.";
    } else if (oauthState.mode === "permanent") {
      status.textContent = "Not connected";
      detail.textContent = "Sign in with your Supabase account. Klean.ly Business will store a private, encrypted organisation grant and give you controls to check, sign out or disconnect.";
    } else {
      status.textContent = oauthState.verified ? "Test verified" : "Not connected";
      detail.textContent = "This temporary test discards all access and refresh tokens. No Supabase project is created or changed.";
    }
  } else if (provider.id === "netlify") {
    if (netlifyState.connected) {
      status.textContent = netlifyState.connection?.status === "connected"
        ? "Connected securely" : "Reconnect needed";
      detail.textContent = "The Netlify grant is encrypted in the installer control plane. No site has been created.";
    } else if (!oauthState.connected) {
      detail.textContent = "Connect Supabase first to unlock Netlify authorisation.";
    } else {
      detail.textContent = "Connect your own Netlify account securely to enable company-owned hosting.";
    }
  } else {
    detail.textContent = provider.status + ". " + provider.secret;
  }
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
  if (provider.id === "supabase") {
    if (oauthState.connected && oauthState.organization) {
      const account = document.createElement("p");
      account.className = "connection-account";
      const primary = document.createElement("strong");
      primary.textContent = oauthState.organization.name;
      const secondary = document.createElement("span");
      secondary.textContent = oauthState.identity?.email
        ? "Signed in as " + oauthState.identity.email : "Supabase organisation authorised";
      account.append(primary, secondary);
      card.append(account);
    }
    const connect = document.createElement("button");
    connect.type = "button";
    connect.className = "action-button provider-oauth";
    connect.textContent = oauthState.configured
      ? oauthState.mode === "permanent"
        ? (oauthState.connected ? "Reconnect this organisation ↗" : "Connect Supabase securely ↗")
        : "Test Supabase authorisation ↗"
      : "Authorisation setup pending";
    connect.disabled = !oauthState.configured;
    connect.addEventListener("click", () => {
      window.location.assign("/.netlify/functions/supabase-oauth-start");
    });
    card.append(connect);
    if (oauthState.mode === "permanent" && oauthState.connected) {
      const actions = document.createElement("div");
      actions.className = "connection-actions";
      for (const [label, action, kind] of [
        ["Check connection", "check", "primary"],
        ["Sign out", "signout", "secondary"],
        ["Disconnect", "disconnect", "destructive"],
      ]) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "connection-action " + kind;
        button.textContent = label;
        button.addEventListener("click", () => performConnectionAction(action));
        actions.append(button);
      }
      card.append(actions);
      const note = document.createElement("p");
      note.className = "provider-note";
      note.textContent = "Disconnect permanently erases this organisation's local credentials and sessions. To revoke Supabase's original consent, also remove Klean.ly Business from your Supabase account.";
      card.append(note);
    }
  }
  if (provider.id === "netlify") {
    if (netlifyState.connected) {
      const account = document.createElement("p");
      account.className = "connection-account";
      const name = document.createElement("strong");
      name.textContent = netlifyState.identity?.email || "Netlify account";
      const sub = document.createElement("span");
      sub.textContent = "Identity verified by Netlify";
      account.append(name, sub);
      card.append(account);
    }
    const connect = document.createElement("button");
    connect.type = "button";
    connect.className = "action-button provider-oauth";
    connect.textContent = !oauthState.connected ? "Connect Supabase first"
      : !netlifyState.configured ? "Authorisation setup pending"
      : netlifyState.connected ? "Reconnect Netlify account ↗" : "Connect Netlify securely ↗";
    connect.disabled = !netlifyState.configured || !oauthState.connected;
    connect.addEventListener("click", () => window.location.assign("/.netlify/functions/netlify-oauth-start"));
    card.append(connect);
    if (netlifyState.connected) {
      const actions = document.createElement("div");
      actions.className = "connection-actions";
      for (const [label, action, kind] of [
        ["Check connection", "check", "primary"], ["Disconnect", "disconnect", "destructive"],
      ]) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "connection-action " + kind;
        button.textContent = label;
        button.addEventListener("click", () => performNetlifyConnectionAction(action));
        actions.append(button);
      }
      card.append(actions);
    }
  }
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

// Supabase OAuth: trust only the server's cookie-bound session status, never
// a query string, localStorage, or a client-supplied owner/company identifier.
async function refreshSupabaseOAuthStatus() {
  const queryResult = new URLSearchParams(window.location.search).get("supabase_test");
  const messages = {
    configuration_required: "The Supabase connection server is not fully configured.",
    denied: "Supabase authorisation was cancelled or denied.",
    expired_or_invalid: "The authorisation session expired or did not match. Try again.",
    invalid_response: "Supabase did not return a valid authorisation code. Try again.",
    exchange_failed: "Supabase could not finish the token exchange. Check the client secret and callback URL.",
    identity_unavailable: "Supabase identity validation was unsuccessful. No credentials were saved.",
    token_response_invalid: "Supabase authorised the app, but did not return the expected OAuth credentials. No connection was saved (T1).",
    profile_identity_invalid: "Supabase returned an account profile without a valid user identifier. No credentials were saved (P1).",
    profile_forbidden: "Supabase did not permit this OAuth grant to read the account profile. No credentials were saved (P2).",
    profile_rate_limited: "Supabase temporarily limited account-profile requests. No credentials were saved (P3).",
    profile_unavailable: "Account-profile verification could not be completed. No credentials were saved (P4).",
    organisations_response_invalid: "Supabase returned an unrecognised organisation-list format. No credentials were saved (O1).",
    organisations_empty: "Supabase returned no organisations accessible to this OAuth grant. No credentials were saved (O2).",
    organisations_multiple: "Supabase returned more than one organisation. The installer will not guess which one to connect (O3).",
    organisations_id_invalid: "Supabase returned an organisation without a valid identifier. No credentials were saved (O4).",
    organisations_forbidden: "Supabase did not permit this OAuth grant to read the organisation list. No credentials were saved (O5).",
    organisations_rate_limited: "Supabase temporarily limited organisation-list requests. No credentials were saved (O6).",
    organisations_unavailable: "Organisation verification could not be completed. No credentials were saved (O7).",
    members_slug_unavailable: "The selected organisation has no usable membership lookup ID. Nothing was saved (M1).",
    members_response_invalid: "Supabase returned an unexpected organisation-member response. Nothing was saved (M2).",
    members_not_single: "This test connector supports only an organisation with exactly one member. Multi-member companies will require independent Klean.ly Business login (M3).",
    members_identity_invalid: "Supabase membership did not contain a valid account identifier. Nothing was saved (M4).",
    members_owner_required: "The only organisation member is not confirmed as an Owner. Nothing was saved (M5).",
    members_forbidden: "Supabase denied permission to verify organisation membership. Check Organisations → Read in your OAuth app (M6).",
    members_rate_limited: "Supabase temporarily limited organisation-member verification. Nothing was saved (M7).",
    members_unavailable: "Supabase organisation-member verification was unavailable. Nothing was saved (M8).",
    storage_unavailable: "The secure portal database could not save this grant. Nothing was connected. Please try later.",
  };
  try {
    const response = await fetch("/.netlify/functions/supabase-oauth-status", {
      credentials: "same-origin", cache: "no-store"
    });
    if (!response.ok) throw new Error("Connection status unavailable");
    const data = await response.json();
    oauthState = {
      configured: data.configured === true, mode: data.mode,
      verified: data.verified === true, connected: data.connected === true,
      connection: data.connection ?? null,
      organization: data.organization ?? null, identity: data.identity ?? null,
      csrfToken: data.csrfToken ?? null,
    };
    byId("supabase-oauth-result").classList.remove("is-error");
    if (queryResult === "connected") {
      setText("supabase-oauth-result", oauthState.mode === "permanent" && oauthState.connected
        ? "Supabase connected successfully. Your organisation grant is encrypted and stored only on the secure server. No customer project has been created."
        : "Unable to confirm a saved connection. Please try again.");
      if (oauthState.connected) goTo(1);
    } else if (queryResult === "verified") {
      setText("supabase-oauth-result", oauthState.mode === "verification-only" && oauthState.verified
        ? "Supabase authorisation was verified successfully. This is a 15-minute TEST confirmation only: no access or refresh tokens were retained."
        : "Unable to validate the temporary verification. Please retry.");
      if (oauthState.verified) goTo(1);
    } else if (messages[queryResult]) {
      setText("supabase-oauth-result", messages[queryResult]);
      byId("supabase-oauth-result").classList.add("is-error");
      goTo(1);
    } else if (oauthState.connected) {
      setText("supabase-oauth-result", "Supabase account connected. You can check its status, reconnect, sign out, or remove its saved credentials below.");
    } else if (oauthState.verified) {
      setText("supabase-oauth-result", "Authorisation test passed for this browser. No credentials are saved.");
    } else {
      setText("supabase-oauth-result", "");
    }
  } catch {
    setText("supabase-oauth-result", "The secure Supabase connection service is temporarily unavailable. Please try later.");
  }
  if (queryResult) {
    window.history.replaceState({}, "", window.location.pathname + window.location.hash);
  }
  renderProviders();
}

async function performConnectionAction(action) {
  if (!oauthState.connected || oauthState.mode !== "permanent" || !oauthState.csrfToken) return;
  if (action === "disconnect" && !window.confirm(
    "Disconnect Supabase and delete this organisation's encrypted credentials and active sessions from Klean.ly Business? This cannot be undone."
  )) return;
  const endpoints = {
    check: "supabase-connection-check",
    signout: "supabase-connection-signout",
    disconnect: "supabase-connection-disconnect",
  };
  if (!endpoints[action]) return;
  setText("supabase-oauth-result", "Checking your secure connection...");
  try {
    const response = await fetch("/.netlify/functions/" + endpoints[action], {
      method: "POST", credentials: "same-origin", cache: "no-store",
      headers: { "X-CSRF-Token": oauthState.csrfToken },
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "The action could not be completed.");
    await refreshSupabaseOAuthStatus();
    await refreshNetlifyOAuthStatus();
    if (action === "check") {
      const message = data.state === "connected" ? "Supabase is connected and your grant is valid."
        : data.state === "reauthorisation_required" ? "Supabase needs to be re-authorised."
        : "Supabase could not be reached for a fresh check. Your saved connection is unchanged.";
      setText("supabase-oauth-result", message);
    } else if (action === "disconnect") {
      setText("supabase-oauth-result", "Supabase disconnected. Klean.ly Business deleted the encrypted grant and its sessions. You may separately revoke the original consent in Supabase.");
    } else {
      setText("supabase-oauth-result", "Signed out of this device. Your encrypted Supabase connection remains safely stored; authorise again to sign in.");
    }
  } catch (error) {
    setText("supabase-oauth-result", error?.message || "This action could not be completed.");
  }
  renderProviders();
}


async function refreshNetlifyOAuthStatus() {
  const result = new URLSearchParams(window.location.search).get("netlify_result");
  const messages = {
    configuration_required: "The Netlify authorisation service is not configured.",
    signin_required: "Connect Supabase before connecting Netlify.",
    denied: "Netlify authorisation was cancelled.",
    invalid_response: "Netlify did not return a valid authorisation code.",
    expired_or_invalid: "Netlify authorisation expired or did not match. Please try again.",
    exchange_failed: "Netlify could not finish authorisation. Check the OAuth redirect and credentials.",
    identity_unavailable: "Netlify could not verify your account. No grant was saved.",
    account_conflict: "A different Netlify account is linked. Disconnect it before switching.",
    storage_unavailable: "The secure Netlify grant could not be saved. Please retry.",
  };
  try {
    const response = await fetch("/.netlify/functions/netlify-oauth-status", {
      credentials: "same-origin", cache: "no-store",
    });
    if (!response.ok) throw new Error("Netlify connection unavailable");
    const data = await response.json();
    netlifyState = {
      configured: data.configured === true, authenticated: data.authenticated === true,
      connected: data.connected === true, identity: data.identity ?? null,
      connection: data.connection ?? null,
    };
    byId("netlify-oauth-result").classList.remove("is-error");
    if (result === "connected") {
      setText("netlify-oauth-result", netlifyState.connected
        ? "Netlify connected securely. No site or deployment has been created."
        : "Netlify connection was not confirmed. Please retry.");
      if (netlifyState.connected) goTo(1);
    } else if (messages[result]) {
      setText("netlify-oauth-result", messages[result]);
      byId("netlify-oauth-result").classList.add("is-error");
      goTo(1);
    } else if (netlifyState.connected) {
      setText("netlify-oauth-result", netlifyState.connection?.status === "connected"
        ? "Netlify account connected. Check its authorisation or disconnect below."
        : "Netlify needs reauthorisation.");
    } else {
      setText("netlify-oauth-result", "");
    }
  } catch {
    setText("netlify-oauth-result", "The Netlify connection service is temporarily unavailable.");
    byId("netlify-oauth-result").classList.add("is-error");
  }
  if (result) window.history.replaceState({}, "", window.location.pathname + window.location.hash);
  renderProviders();
}

async function performNetlifyConnectionAction(action) {
  if (!oauthState.connected || !oauthState.csrfToken || !netlifyState.connected) return;
  if (action === "disconnect" && !window.confirm(
    "Disconnect Netlify and delete its saved encrypted grant? Supabase will stay connected."
  )) return;
  const endpoint = {
    check: "netlify-connection-check", disconnect: "netlify-connection-disconnect",
  }[action];
  if (!endpoint) return;
  setText("netlify-oauth-result", "Checking the Netlify connection...");
  try {
    const response = await fetch("/.netlify/functions/" + endpoint, {
      method: "POST", credentials: "same-origin", cache: "no-store",
      headers: { "X-CSRF-Token": oauthState.csrfToken },
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Netlify action failed.");
    await refreshNetlifyOAuthStatus();
    if (action === "check") {
      setText("netlify-oauth-result", data.state === "connected"
        ? "Netlify is connected and the grant is valid."
        : data.state === "reauthorisation_required" ? "Netlify needs reauthorisation."
        : "Netlify could not be verified right now. The saved grant is unchanged.");
    } else {
      setText("netlify-oauth-result", "Netlify disconnected. Your Supabase connection was not changed.");
    }
  } catch (error) {
    setText("netlify-oauth-result", error?.message || "Netlify action failed.");
    byId("netlify-oauth-result").classList.add("is-error");
  }
  renderProviders();
}
refreshSupabaseOAuthStatus().then(refreshNetlifyOAuthStatus);
