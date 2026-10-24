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
let preflightInProgress = false;
let installationPreviewPending = false;
let freeCapacityPending = false;
let pilotProposalPending = false;
let pilotCreationPending = false;
let crmDatabaseReviewPending = false;
let crmSchemaProposalPending = false;
let crmSchemaApprovalPending = false;
let crmSchemaInstallPending = false;
let ownerReadinessPending = false;
let crmSiteProposalPending = false;
let crmSiteCapacityPending = false;
let crmSiteApprovalPending = false;
let crmSiteCreationPending = false;
let crmDeploymentReviewPending = false;
let ownerAuthReviewPending = false;
let crmPublicKeyPending = false;
let crmAccessReviewPending = false;
let crmDeployStatusPending = false;
let crmDeploySubmitPending = false;
let crmDeploySubmittedInThisTab = false;
let crmDeployAlreadyAttempted = false;
let crmSiteApproval = null;
let crmSchemaInstallProposal = null;
let pilotProposal = null;

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
      clearInstallationPreview();
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
  byId("check-provisioning-readiness").disabled = preflightInProgress || !oauthState.connected || !netlifyState.connected || !oauthState.csrfToken;
  byId("preview-installation-plan").disabled = installationPreviewPending || !oauthState.connected || !netlifyState.connected || !oauthState.csrfToken;
  byId("check-free-project-capacity").disabled = freeCapacityPending || !oauthState.connected || !netlifyState.connected || !oauthState.csrfToken;
  byId("review-test-project").disabled = pilotProposalPending || pilotCreationPending || !oauthState.connected || !netlifyState.connected || !oauthState.csrfToken;
  byId("review-crm-database").disabled = crmDatabaseReviewPending || !oauthState.connected || !netlifyState.connected || !oauthState.csrfToken;
  byId("review-crm-schema").disabled = crmSchemaProposalPending || !oauthState.connected || !netlifyState.connected || !oauthState.csrfToken;
  byId("review-crm-installation").disabled = crmSchemaApprovalPending || crmSchemaInstallPending || !oauthState.connected || !netlifyState.connected || !oauthState.csrfToken;
  byId("check-owner-readiness").disabled = ownerReadinessPending || !oauthState.connected || !netlifyState.connected || !oauthState.csrfToken;
  byId("review-crm-site").disabled = crmSiteProposalPending || !oauthState.connected || !netlifyState.connected || !oauthState.csrfToken;
  byId("review-crm-capacity").disabled = crmSiteCapacityPending || !oauthState.connected || !netlifyState.connected || !oauthState.csrfToken;
  byId("review-crm-site-create").disabled = crmSiteApprovalPending || crmSiteCreationPending || !oauthState.connected || !netlifyState.connected || !oauthState.csrfToken;
  byId("review-crm-deployment").disabled = crmDeploymentReviewPending || !oauthState.connected || !netlifyState.connected || !oauthState.csrfToken;
  byId("review-crm-access").disabled = crmAccessReviewPending ||
    !oauthState.connected || !netlifyState.connected || !oauthState.csrfToken;
  byId("review-crm-public-key").disabled = crmPublicKeyPending ||
    !oauthState.connected || !netlifyState.connected || !oauthState.csrfToken ||
    !/^sb_publishable_[A-Za-z0-9_-]{16,200}$/.test(byId("crm-public-key").value);
  byId("review-owner-auth-setup").disabled = ownerAuthReviewPending || !oauthState.connected || !netlifyState.connected || !oauthState.csrfToken;
  byId("check-crm-app-deploy").disabled = crmDeployStatusPending ||
    !oauthState.connected || !netlifyState.connected || !oauthState.csrfToken;
  byId("submit-crm-app-deploy").disabled = crmDeploySubmitPending ||
    crmDeploySubmittedInThisTab || crmDeployAlreadyAttempted ||
    !oauthState.connected || !netlifyState.connected || !oauthState.csrfToken ||
    !/^sb_publishable_[A-Za-z0-9_-]{16,200}$/.test(byId("crm-deploy-public-key").value) ||
    !byId("crm-deploy-credits").checked || !byId("crm-deploy-one").checked ||
    byId("crm-deploy-phrase").value !== "DEPLOY ONE TEST CRM";
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
    clearInstallationPreview();
  });
}
identityForm.addEventListener("submit", (event) => { event.preventDefault(); goTo(1); });
byId("next-step").addEventListener("click", () => goTo(step === STEP_COUNT - 1 ? 0 : step + 1));
byId("previous-step").addEventListener("click", () => goTo(step - 1));
document.querySelectorAll("[data-step]").forEach((button) => {
  button.addEventListener("click", () => goTo(Number(button.dataset.step)));
});
byId("download-manifest").addEventListener("click", downloadManifest);
byId("check-provisioning-readiness").addEventListener("click", checkProvisioningReadiness);
byId("preview-installation-plan").addEventListener("click", previewInstallation);
byId("check-free-project-capacity").addEventListener("click", checkFreeProjectCapacity);
byId("review-test-project").addEventListener("click", reviewTestProject);
byId("review-crm-database").addEventListener("click", reviewCrmDatabase);
byId("review-crm-schema").addEventListener("click", reviewCrmSchema);
byId("review-crm-installation").addEventListener("click", reviewCrmSchemaInstallation);
byId("check-owner-readiness").addEventListener("click", checkOwnerLoginReadiness);
byId("review-crm-site").addEventListener("click", reviewCrmSiteProposal);
byId("review-crm-capacity").addEventListener("click", reviewCrmSiteCapacity);
byId("review-crm-site-create").addEventListener("click", reviewCrmSiteCreation);
byId("review-crm-deployment").addEventListener("click", reviewCrmDeploymentReadiness);
byId("review-crm-package").addEventListener("click", reviewCrmPackageSource);
byId("crm-public-key").addEventListener("input", renderProviders);
byId("crm-public-key-form").addEventListener("submit", reviewCrmPublicKey);
byId("review-crm-access").addEventListener("click", reviewCrmAccess);
byId("crm-deploy-public-key").addEventListener("input", renderProviders);
byId("crm-deploy-credits").addEventListener("change", renderProviders);
byId("crm-deploy-one").addEventListener("change", renderProviders);
byId("crm-deploy-phrase").addEventListener("input", renderProviders);
byId("check-crm-app-deploy").addEventListener("click", checkCrmAppDeploymentStatus);
byId("crm-app-deploy-form").addEventListener("submit", submitOneCrmAppDeployment);
byId("review-owner-auth-setup").addEventListener("click", reviewOwnerAuthSetup);
byId("crm-site-confirm-phrase").addEventListener("input", updateCrmSiteCreationState);
byId("crm-site-accept-credits").addEventListener("change", updateCrmSiteCreationState);
byId("crm-site-accept-one").addEventListener("change", updateCrmSiteCreationState);
byId("crm-site-create-form").addEventListener("submit", createOneCrmSite);
byId("crm-schema-confirm-phrase").addEventListener("input", updateCrmSchemaInstallState);
byId("crm-schema-accept-changes").addEventListener("change", updateCrmSchemaInstallState);
byId("crm-schema-install-approval").addEventListener("submit", installOneCrmSchema);
byId("pilot-confirm-phrase").addEventListener("input", updatePilotApprovalState);
byId("pilot-accept-costs").addEventListener("change", updatePilotApprovalState);
byId("test-project-approval").addEventListener("submit", createOneTestProject);
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
async function checkProvisioningReadiness() {
  if (preflightInProgress || !oauthState.connected || !netlifyState.connected || !oauthState.csrfToken) return;
  preflightInProgress = true;
  renderProviders();
  const output = byId("provisioning-readiness-result");
  output.classList.remove("is-error");
  output.textContent = "Checking your linked accounts and Supabase projects. This creates nothing...";
  try {
    const response = await fetch("/.netlify/functions/provisioning-preflight", {
      method: "POST", cache: "no-store", credentials: "same-origin",
      headers: { "X-CSRF-Token": oauthState.csrfToken },
    });
    const data = await response.json();
    if (!response.ok) throw new Error((data.error || "Cannot verify installation prerequisites right now.") +
      (data.code ? " (Reference: " + data.code + ")" : ""));
    const count = data.mayHaveMoreProjects
      ? "at least " + data.observedProjectCount
      : String(data.observedProjectCount);
    output.textContent = "Read-only checks passed: Supabase organisation " +
      data.organizationName + " has " + count + " project(s), and your Netlify grant is valid. " +
      "No site or database was created. Available free project quota and any costs have not been confirmed. " +
      "Automated installation remains disabled until billing is checked and explicitly approved.";
  } catch (error) {
    output.classList.add("is-error");
    output.textContent = (error?.message || "Readiness check unavailable.") +
      " No project or website was created.";
  } finally {
    preflightInProgress = false;
    renderProviders();
  }
}


function clearInstallationPreview() {
  const output = byId("installation-plan-result");
  output.replaceChildren();
  output.hidden = true;
  output.classList.remove("is-error");
}

function appendInstallationParagraph(parent, value, className = "") {
  const p = document.createElement("p");
  if (className) p.className = className;
  p.textContent = value;
  parent.append(p);
}

function renderInstallationPreview(plan) {
  if (plan?.mode !== "preview_only" || plan.installationEnabled !== false ||
      plan.installationsCreated !== false || !Array.isArray(plan.steps)) {
    throw new Error("The server did not return a safe installation preview.");
  }
  const output = byId("installation-plan-result");
  output.replaceChildren();
  output.hidden = false;
  output.classList.remove("is-error");

  const heading = document.createElement("h3");
  heading.textContent = "Installation plan for " + plan.business.name;
  output.append(heading);
  appendInstallationParagraph(output,
    "Supabase: " + plan.supabase.organization +
    " (" + plan.supabase.projectsObserved + " existing project(s)). " +
    "Netlify: connected account verified."
  );
  const pilot = plan.supabase?.pilotProject;
  const pilotCreated = pilot?.status === "created_in_staging";
  if (pilotCreated) {
    appendInstallationParagraph(output,
      "Staging pilot project already recorded as created: " + pilot.name +
      " (" + pilot.ref + "). Full customer installation is not yet implemented."
    );
  }
  appendInstallationParagraph(output,
    "Proposed domain: " + (plan.business.domain || "Not yet selected") +
    (pilotCreated
      ? ". The staging project used the Europe / EMEA selection; verify its final region before installing the CRM."
      : ". Database region and availability must be confirmed before installation.")
  );

  const list = document.createElement("ol");
  const statusLabels = {
    required: "Approval required before continuing",
    pilot_created: "Created by separate staging pilot — full installer pending",
    not_implemented: "Not implemented — no action taken",
  };
  for (const step of plan.steps) {
    const item = document.createElement("li");
    item.textContent = step.title;
    const status = document.createElement("span");
    status.textContent = statusLabels[step.state] || "Not started";
    item.append(status);
    list.append(item);
  }
  output.append(list);

  const futureProviders = plan.integrations.filter((item) => item.state === "setup_required");
  if (futureProviders.length) {
    appendInstallationParagraph(output,
      "Still to configure: " + futureProviders.map((item) => item.name).join(", ") + "."
    );
  }
  appendInstallationParagraph(output,
    "Read-only preview: this check created no new project, site, deployment or payment. " +
    (pilotCreated
      ? "The separately approved staging pilot project already exists. No CRM schema or customer Netlify site has been installed. "
      : "No Supabase project or Netlify site was installed by this preview. ") +
    "Full automated installation remains disabled until dedicated owner login, " +
    "billing safeguards, customer system packaging, and explicit approval are implemented.",
    "installation-warning"
  );
}

async function reviewCrmDatabase() {
  if (crmDatabaseReviewPending || !oauthState.connected ||
      !netlifyState.connected || !oauthState.csrfToken) return;
  crmDatabaseReviewPending = true;
  renderProviders();
  const output = byId("crm-database-review-result");
  output.classList.remove("is-error");
  output.classList.remove("is-warning");
  output.textContent = "Checking the approved test project and CRM tables (read-only)...";
  try {
    const response = await fetch("/.netlify/functions/crm-database-review", {
      method: "POST", credentials: "same-origin", cache: "no-store",
      headers: { "X-CSRF-Token": oauthState.csrfToken },
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "CRM database check unavailable.");
    if (data.mode !== "read_only_staging_crm_review" ||
        data.writeAttempted !== false || data.installationEnabled !== false ||
        data.schemaInstalled !== false || data.projectVerified !== true ||
        typeof data.projectName !== "string" || typeof data.projectRef !== "string") {
      throw new Error("The server returned an unexpected database review.");
    }
    const details = data.projectName + " (" + data.projectRef + "). " +
      "Region: " + (data.region || "not yet confirmed") + ". ";
    if (data.state === "schema_ready_for_approval" &&
        data.schemaVerified === true && data.readyForSeparateApproval === true) {
      output.textContent = "Project verified: " + details +
        "No Klean.ly directory or CRM tables detected. Database is ready for " +
        "a separately approved schema-install step. No changes were made.";
    } else if (data.state === "database_permission_required") {
      output.classList.add("is-warning");
      output.textContent = "Project verified: " + details +
        "The current Supabase OAuth grant cannot inspect database tables. " +
        "Database access permission must be approved before installing the CRM. " +
        "No changes were made.";
    } else if (data.state === "directory_tables_blocked") {
      output.classList.add("is-error");
      output.textContent = "Installation BLOCKED. Project: " + details +
        "Klean.ly directory tables were detected. Do not install the CRM here.";
    } else if (data.state === "existing_schema_needs_review") {
      output.classList.add("is-warning");
      output.textContent = "Project verified: " + details +
        "Existing CRM schema objects were detected (" + data.existingCrmTables +
        "). The schema must be reviewed before any installation or retry.";
    } else {
      output.classList.add("is-warning");
      output.textContent = "Project verified: " + details +
        (data.note || "Database readiness has not been confirmed.") +
        " No changes were made.";
    }
  } catch (error) {
    output.classList.add("is-error");
    output.textContent = (error?.message || "Unable to inspect the CRM database.") +
      " No schema installation was requested.";
  } finally {
    crmDatabaseReviewPending = false;
    renderProviders();
  }
}

async function reviewCrmSchema() {
  if (crmSchemaProposalPending || !oauthState.connected ||
      !netlifyState.connected || !oauthState.csrfToken) return;
  crmSchemaProposalPending = true;
  renderProviders();
  const output = byId("crm-schema-proposal-result");
  output.hidden = false;
  output.classList.remove("is-error");
  output.replaceChildren();
  appendInstallationParagraph(output, "Preparing the read-only CRM schema proposal...");
  try {
    const response = await fetch("/.netlify/functions/crm-schema-proposal", {
      method: "POST", credentials: "same-origin", cache: "no-store",
      headers: { "X-CSRF-Token": oauthState.csrfToken },
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "The CRM schema cannot be reviewed yet.");
    if (data.mode !== "read_only_crm_schema_proposal" ||
        data.blueprintVersion !== 1 ||
        data.readyForOwnerApproval !== true ||
        data.separateOwnerConfirmationRequired !== true ||
        data.schemaInstallEnabled !== false ||
        data.schemaApplied !== false ||
        data.writeAttempted !== false ||
        data.rowLevelSecurityIncluded !== true ||
        !Array.isArray(data.publicTables) ||
        data.publicTables.length !== 8 ||
        typeof data.projectName !== "string" ||
        typeof data.projectRef !== "string") {
      throw new Error("The installer returned an unexpected schema proposal.");
    }
    output.replaceChildren();
    const heading = document.createElement("h3");
    heading.textContent = "CRM database blueprint v" + data.blueprintVersion;
    output.append(heading);
    appendInstallationParagraph(output, "Verified project: " + data.projectName +
      " (" + data.projectRef + "). Region: " + data.region + ".");
    appendInstallationParagraph(output, "The following " + data.publicTables.length +
      " business tables will be created after a separate confirmation:");
    const items = document.createElement("ol");
    for (const table of data.publicTables) {
      if (typeof table.name !== "string" || typeof table.purpose !== "string") {
        throw new Error("Unexpected schema table description.");
      }
      const item = document.createElement("li");
      item.textContent = table.name + " — " + table.purpose;
      items.append(item);
    }
    output.append(items);
    appendInstallationParagraph(output,
      "Also included: a private schema version record and row-level security. " +
      "No customer details are copied; no owner account, website, or CRM app is installed at this stage.");
    appendInstallationParagraph(output,
      "REVIEW ONLY — schema installation is not yet enabled. " +
      "We'll add a separate, protected confirmation before any database changes.",
      "installation-warning");
  } catch (error) {
    output.classList.add("is-error");
    output.replaceChildren();
    appendInstallationParagraph(output, (error?.message || "Cannot review CRM schema.") +
      " No database changes were made.");
  } finally {
    crmSchemaProposalPending = false;
    renderProviders();
  }
}

function updateCrmSchemaInstallState() {
  const canInstall = crmSchemaInstallProposal?.installationUnlocked === true &&
    !crmSchemaInstallProposal.existingAttempt &&
    !crmSchemaInstallPending &&
    byId("crm-schema-accept-changes").checked &&
    byId("crm-schema-confirm-phrase").value === crmSchemaInstallProposal.confirmationPhrase;
  byId("install-one-crm-schema").disabled = !canInstall;
}

function clearCrmSchemaInstallProposal() {
  crmSchemaInstallProposal = null;
  byId("crm-schema-install-approval").hidden = true;
  byId("crm-schema-accept-changes").checked = false;
  byId("crm-schema-confirm-phrase").value = "";
  updateCrmSchemaInstallState();
}

async function reviewCrmSchemaInstallation() {
  if (crmSchemaApprovalPending || crmSchemaInstallPending ||
      !oauthState.connected || !netlifyState.connected || !oauthState.csrfToken) return;
  crmSchemaApprovalPending = true;
  clearCrmSchemaInstallProposal();
  renderProviders();
  const output = byId("crm-schema-install-proposal-result");
  output.classList.remove("is-warning");
  output.classList.remove("is-error");
  output.textContent = "Rechecking the verified staging project and one-time install lock...";
  try {
    const response = await fetch("/.netlify/functions/crm-schema-approval", {
      method: "POST", credentials: "same-origin", cache: "no-store",
      headers: { "X-CSRF-Token": oauthState.csrfToken },
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "CRM installation approval is unavailable.");
    if (data.mode !== "staging_crm_schema_pilot" ||
        typeof data.projectName !== "string" ||
        typeof data.projectRef !== "string" ||
        data.writeAttempted !== false ||
        typeof data.installationUnlocked !== "boolean") {
      throw new Error("Unexpected CRM installation approval status.");
    }
    const heading = "Project: " + data.projectName + " (" + data.projectRef + "). ";
    if (data.existingAttempt) {
      output.classList.add("is-warning");
      output.textContent = heading +
        "An earlier CRM schema installation attempt already exists (status: " +
        data.existingAttempt.status + "). No second request is allowed. " +
        (data.schemaInstalled
          ? "The staging installer recorded a successful schema installation."
          : "Check Supabase before making any changes.");
    } else if (!data.installationUnlocked) {
      output.classList.add("is-warning");
      output.textContent = heading +
        "The test database is eligible for installation. REAL CRM SCHEMA INSTALLATION " +
        "IS LOCKED pending your separate approval to enable this staging-only feature. " +
        "Review only — no tables were created.";
    } else {
      if (data.installationLocked !== false ||
          data.needsSeparateConfirmation !== true ||
          data.blueprintVersion !== 1 ||
          data.confirmationPhrase !== "INSTALL CRM SCHEMA V1") {
        throw new Error("Unexpected final CRM confirmation settings.");
      }
      crmSchemaInstallProposal = data;
      output.textContent = heading +
        "CRM schema pilot unlocked. To install eight real tables and row security, " +
        "acknowledge the database changes and enter the confirmation phrase below.";
      byId("crm-schema-confirm-phrase-display").textContent = data.confirmationPhrase;
      byId("crm-schema-install-approval").hidden = false;
    }
  } catch (error) {
    output.classList.add("is-error");
    output.textContent = (error?.message || "Unable to review CRM installation.") +
      " No database changes were made.";
  } finally {
    crmSchemaApprovalPending = false;
    updateCrmSchemaInstallState();
    renderProviders();
  }
}

async function installOneCrmSchema(event) {
  event.preventDefault();
  if (crmSchemaInstallPending ||
      crmSchemaInstallProposal?.installationUnlocked !== true ||
      crmSchemaInstallProposal.existingAttempt ||
      !byId("crm-schema-accept-changes").checked ||
      byId("crm-schema-confirm-phrase").value !== crmSchemaInstallProposal.confirmationPhrase ||
      !oauthState.csrfToken) return;
  if (!window.confirm(
    "FINAL CONFIRMATION: Install the real CRM database schema (8 tables plus " +
    "row-level security) into " + crmSchemaInstallProposal.projectName +
    "? This permanently changes your test Supabase project. " +
    "No owner account or website will be created."
  )) return;

  crmSchemaInstallPending = true;
  updateCrmSchemaInstallState();
  renderProviders();
  const output = byId("crm-schema-install-result");
  output.classList.remove("is-error");
  output.textContent = "Sending the ONE approved schema-install request. Do not retry or refresh...";
  try {
    const response = await fetch("/.netlify/functions/crm-schema-install", {
      method: "POST", credentials: "same-origin", cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": oauthState.csrfToken,
      },
      body: JSON.stringify({
        confirmation: crmSchemaInstallProposal.confirmationPhrase,
        acknowledgeSchemaChanges: true,
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error((data.error || "Schema installation could not be confirmed.") +
        " Do NOT retry without verifying the database.");
    }
    if (data.state !== "crm_schema_applied" ||
        data.schemaInstalled !== true ||
        data.rowLevelSecurityVerified !== true ||
        data.publicTableCount !== 8 ||
        data.projectRef !== crmSchemaInstallProposal.projectRef) {
      throw new Error("The server could not confirm schema security. Do NOT retry.");
    }
    output.textContent = "CRM schema v1 installed and verified: " +
      data.publicTableCount + " tables with row-level security in " +
      data.projectName + ". No owner account, website or CRM app was created.";
  } catch (error) {
    output.classList.add("is-error");
    output.textContent = (error?.message || "CRM schema status unknown.") +
      " Do not send another request.";
  } finally {
    crmSchemaInstallPending = false;
    clearCrmSchemaInstallProposal();
    renderProviders();
  }
}

async function checkOwnerLoginReadiness() {
  if (ownerReadinessPending || !oauthState.connected ||
      !netlifyState.connected || !oauthState.csrfToken) return;
  ownerReadinessPending = true;
  renderProviders();
  const output = byId("owner-readiness-result");
  output.classList.remove("is-error");
  output.classList.remove("is-warning");
  output.textContent = "Verifying the dedicated CRM owner records and security (read-only)...";
  try {
    const response = await fetch("/.netlify/functions/owner-login-readiness", {
      method: "POST", credentials: "same-origin", cache: "no-store",
      headers: { "X-CSRF-Token": oauthState.csrfToken },
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Owner readiness is unavailable.");
    if (data.mode !== "staging_owner_login_readiness" ||
        data.projectVerified !== true ||
        data.ownerInvitationEnabled !== false || data.ownerCreated !== false ||
        data.emailSent !== false || data.writeAttempted !== false ||
        typeof data.projectName !== "string") {
      throw new Error("Unexpected owner readiness response.");
    }
    const heading = "Project verified: " + data.projectName + ". ";
    if (data.state === "owner_setup_can_be_prepared" &&
        data.schemaVerified === true && data.eightTablesConfirmed === true &&
        data.eightRlsConfirmed === true &&
        data.readyForInvitationDevelopment === true) {
      output.textContent = heading +
        "Eight CRM tables and row-level security verified. " +
        "No business owner or staff member has been assigned. " +
        "Next: a secure owner invitation with your chosen email and a " +
        "dedicated CRM website login URL. No login or email was created.";
    } else if (data.state === "owner_already_present") {
      output.classList.add("is-warning");
      output.textContent = heading +
        "An existing owner or staff record was detected. " +
        "Do not create a second first-owner account. No changes were made.";
    } else if (data.state === "schema_security_review_required") {
      output.classList.add("is-error");
      output.textContent = heading +
        "Owner setup is blocked until the installed schema security is reviewed. " +
        "No changes were made.";
    } else {
      output.classList.add("is-warning");
      output.textContent = heading +
        (data.note || "Owner invitation is not ready.") +
        " No changes were made.";
    }
  } catch (error) {
    output.classList.add("is-error");
    output.textContent = (error?.message || "Owner readiness unavailable.") +
      " No invitation was sent.";
  } finally {
    ownerReadinessPending = false;
    renderProviders();
  }
}

async function reviewCrmSiteProposal() {
  if (crmSiteProposalPending || !oauthState.connected ||
      !netlifyState.connected || !oauthState.csrfToken) return;
  crmSiteProposalPending = true;
  renderProviders();
  const output = byId("crm-site-proposal-result");
  output.classList.remove("is-error");
  output.classList.remove("is-warning");
  output.textContent = "Checking your separately connected test Netlify account (read-only)...";
  try {
    const response = await fetch("/.netlify/functions/crm-site-proposal", {
      method: "POST", credentials: "same-origin", cache: "no-store",
      headers: { "X-CSRF-Token": oauthState.csrfToken },
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "CRM site readiness could not be checked.");
    if (data.mode !== "read_only_crm_site_proposal" ||
        data.proposedSiteName !== "kleanly-business-crm-pilot" ||
        data.proposedSiteUrl !== "https://kleanly-business-crm-pilot.netlify.app" ||
        typeof data.connectedNetlifyEmail !== "string" ||
        data.ownerEmail !== "kleanlytest@gerball.co.uk" ||
        !Array.isArray(data.testNetlifyTeams) ||
        data.testNetlifyTeams.length < 1 ||
        typeof data.matchingSitesInConnectedAccount !== "number" ||
        data.siteCreated !== false ||
        data.deploymentCreated !== false ||
        data.invitationSent !== false ||
        data.readyToCreateSite !== false ||
        data.providerBillingApproved !== false ||
        data.globalNameAvailabilityConfirmed !== false ||
        data.writeAttempted !== false) {
      throw new Error("Unexpected test website proposal.");
    }
    const teams = data.testNetlifyTeams.map((t) => {
      if (!t || typeof t.name !== "string" || typeof t.slug !== "string" ||
          typeof t.plan !== "string") {
        throw new Error("Unexpected test Netlify team details.");
      }
      return t.name + " (" + t.slug + "), plan: " + t.plan;
    }).join("; ");
    const heading = "Proposed CRM: " + data.proposedSiteUrl +
      ". Owner login: " + data.ownerEmail + ". " +
      "Connected Netlify account: " + data.connectedNetlifyEmail + ". " +
      "Available teams in that account: " + teams + ". ";
    if (data.existingSiteReviewRequired === true) {
      output.classList.add("is-warning");
      output.textContent = heading +
        "A matching website is already visible to this connected account. " +
        "We must inspect it before attempting site creation. No changes were made.";
    } else {
      output.textContent = heading +
        "No matching website was found among the sites visible to this account. " +
        "Global name availability is not yet guaranteed. " +
        "Next we will confirm which team owns the new site and check provider billing before enabling creation. " +
        "No website or owner invitation was created.";
    }
  } catch (error) {
    output.classList.add("is-error");
    output.textContent = (error?.message || "CRM website review unavailable.") +
      " No website was created.";
  } finally {
    crmSiteProposalPending = false;
    renderProviders();
  }
}

async function reviewCrmSiteCapacity() {
  if (crmSiteCapacityPending || !oauthState.connected ||
      !netlifyState.connected || !oauthState.csrfToken) return;
  crmSiteCapacityPending = true;
  renderProviders();
  const output = byId("crm-capacity-result");
  output.classList.remove("is-error");
  output.classList.remove("is-warning");
  output.textContent = "Checking the approved test team, Free Plan and website limit (read-only)...";
  try {
    const response = await fetch("/.netlify/functions/crm-free-site-capacity", {
      method: "POST", credentials: "same-origin", cache: "no-store",
      headers: { "X-CSRF-Token": oauthState.csrfToken },
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Netlify hosting limits could not be checked.");
    if (data.mode !== "read_only_crm_free_site_capacity" ||
        data.teamSlug !== "kleanlytest" ||
        data.ownerEmail !== "kleanlytest@gerball.co.uk" ||
        data.connectedNetlifyAccount !== "kleanlytest@gerball.co.uk" ||
        data.proposedSiteUrl !== "https://kleanly-business-crm-pilot.netlify.app" ||
        data.confirmedFreePlan !== true ||
        data.documentedFreeProjectLimit !== 500 ||
        !Number.isSafeInteger(data.sitesInTeam) ||
        data.globalNameAvailabilityConfirmed !== false ||
        data.remainingMonthlyCreditsVerified !== false ||
        data.providerCostApprovalRequired !== true ||
        data.creationEnabled !== false ||
        data.siteCreated !== false ||
        data.deploymentCreated !== false ||
        data.emailSent !== false ||
        data.writeAttempted !== false) {
      throw new Error("The Netlify hosting check returned unexpected data.");
    }
    const label = "Netlify test team: " + data.teamName + " (Free Plan). " +
      "Existing team websites: " + data.sitesInTeam +
      " of the documented " + data.documentedFreeProjectLimit + " project limit. ";
    if (data.matchingNameInChosenTeam === true) {
      output.classList.add("is-warning");
      output.textContent = label +
        "The proposed CRM website already exists in the test team. " +
        "We must review it rather than create a duplicate. No changes were made.";
    } else if (data.capacityAppearsAvailable !== true) {
      output.classList.add("is-warning");
      output.textContent = label +
        "Website capacity is not confirmed. Do not proceed with creation. " +
        "No changes were made.";
    } else {
      output.textContent = label +
        "The team appears to have room for one CRM pilot website, and no " +
        "matching name was found within this team. Global name availability and " +
        "the current monthly credit balance have NOT been confirmed. " +
        "Next we must review the remaining credits and obtain final approval " +
        "before creating any site. No website, deployment or login was created.";
    }
  } catch (error) {
    output.classList.add("is-error");
    output.textContent = (error?.message || "Netlify site capacity unavailable.") +
      " No website was created.";
  } finally {
    crmSiteCapacityPending = false;
    renderProviders();
  }
}

function updateCrmSiteCreationState() {
  byId("create-one-crm-site").disabled = !(
    crmSiteApproval?.creationUnlocked === true &&
    crmSiteApproval.existingAttempt === null &&
    !crmSiteCreationPending &&
    byId("crm-site-accept-credits").checked &&
    byId("crm-site-accept-one").checked &&
    byId("crm-site-confirm-phrase").value === crmSiteApproval.confirmationPhrase
  );
}

function resetCrmSiteCreationForm() {
  crmSiteApproval = null;
  byId("crm-site-create-form").hidden = true;
  byId("crm-site-accept-credits").checked = false;
  byId("crm-site-accept-one").checked = false;
  byId("crm-site-confirm-phrase").value = "";
  updateCrmSiteCreationState();
}

async function reviewCrmSiteCreation() {
  if (crmSiteApprovalPending || crmSiteCreationPending ||
      !oauthState.connected || !netlifyState.connected || !oauthState.csrfToken) return;
  crmSiteApprovalPending = true;
  resetCrmSiteCreationForm();
  renderProviders();
  const output = byId("crm-site-create-proposal-result");
  output.classList.remove("is-error");
  output.classList.remove("is-warning");
  output.textContent = "Rechecking Netlify Free Plan and the permanent one-site safety lock...";
  try {
    const response = await fetch("/.netlify/functions/crm-site-approval", {
      method: "POST", credentials: "same-origin", cache: "no-store",
      headers: { "X-CSRF-Token": oauthState.csrfToken },
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Site creation review unavailable.");
    if (data.mode !== "staging_one_crm_site_pilot" ||
        data.proposedSiteUrl !== "https://kleanly-business-crm-pilot.netlify.app" ||
        typeof data.creationUnlocked !== "boolean" ||
        data.creationLocked === data.creationUnlocked ||
        data.writeAttempted !== false) {
      throw new Error("Unexpected website approval response.");
    }
    if (data.existingAttempt) {
      output.classList.add("is-warning");
      output.textContent = "A prior site creation attempt is recorded (status: " +
        data.existingAttempt.status + "). " +
        (data.siteCreated ? "A site has been recorded as created." :
          "The result needs manual review in Netlify.") +
        " No automatic retries are allowed.";
    } else if (!data.creationUnlocked) {
      output.classList.add("is-warning");
      output.textContent = "The verified test Free Plan team appears eligible. " +
        "REAL CRM WEBSITE CREATION IS LOCKED pending your separate approval " +
        "to enable the one-site pilot. No site, deployment, or login was created.";
    } else {
      if (data.confirmationPhrase !== "CREATE ONE CRM WEBSITE" ||
          data.needsFinalConfirmation !== true ||
          data.confirmedFreePlan !== true ||
          data.noPaidAddonsRequested !== true ||
          data.siteIsEmptyUntilDeployment !== true ||
          data.siteCreated !== false ||
          data.deployed !== false || data.invitationSent !== false) {
        throw new Error("Unexpected final website confirmation settings.");
      }
      crmSiteApproval = data;
      output.textContent = "The one-site pilot is unlocked. Approve one empty website " +
        "in the Free Plan test team, acknowledge credit usage and type the phrase below.";
      byId("crm-site-confirm-display").textContent = data.confirmationPhrase;
      byId("crm-site-create-form").hidden = false;
    }
  } catch(error) {
    output.classList.add("is-error");
    output.textContent = (error?.message || "Website review unavailable.") +
      " No site was created.";
  } finally {
    crmSiteApprovalPending = false;
    updateCrmSiteCreationState();
    renderProviders();
  }
}

async function createOneCrmSite(event) {
  event.preventDefault();
  if (crmSiteCreationPending || crmSiteApproval?.creationUnlocked !== true ||
      crmSiteApproval?.existingAttempt !== null ||
      !byId("crm-site-accept-credits").checked ||
      !byId("crm-site-accept-one").checked ||
      byId("crm-site-confirm-phrase").value !== crmSiteApproval.confirmationPhrase ||
      !oauthState.csrfToken) return;
  if (!window.confirm(
    "FINAL CONFIRMATION: Create ONE real but EMPTY website " +
    "kleanly-business-crm-pilot.netlify.app in the kleanlytest Free Plan team? " +
    "It may use Free Plan credits. No login, paid add-ons or CRM deployment will be created."
  )) return;
  crmSiteCreationPending = true;
  updateCrmSiteCreationState();
  renderProviders();
  const output = byId("crm-site-create-result");
  output.classList.remove("is-error");
  output.textContent = "Sending ONE Netlify website creation request. Do not refresh or retry...";
  try {
    const response = await fetch("/.netlify/functions/crm-site-create", {
      method: "POST", credentials: "same-origin", cache: "no-store",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": oauthState.csrfToken },
      body: JSON.stringify({
        confirmation: crmSiteApproval.confirmationPhrase,
        acknowledgeFreeCredits: true,
        acknowledgeSingleEmptySite: true,
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(
      (data.error || "Netlify could not confirm creation.") + " Do NOT retry."
    );
    if (data.mode !== "staging_one_crm_site_pilot" ||
        data.state !== "crm_empty_site_created" ||
        data.siteCreated !== true ||
        data.siteName !== "kleanly-business-crm-pilot" ||
        data.siteUrl !== "https://kleanly-business-crm-pilot.netlify.app" ||
        data.teamSlug !== "kleanlytest" ||
        typeof data.siteId !== "string" ||
        data.deployed !== false || data.ownerCreated !== false ||
        data.invitationSent !== false) {
      throw new Error("Unexpected website creation result. Do NOT retry.");
    }
    output.textContent = "One empty test CRM website created and verified: " +
      data.siteUrl + ". Site ID: " + data.siteId +
      ". The CRM app and owner login are not installed yet.";
  } catch(error) {
    output.classList.add("is-error");
    output.textContent = (error?.message || "Website outcome unknown.") +
      " Do not send another request until the Netlify test account is checked.";
  } finally {
    crmSiteCreationPending = false;
    resetCrmSiteCreationForm();
    renderProviders();
  }
}

// The API returns only these pre-auth, safe messages; never reflect arbitrary
// provider responses, API keys or stack traces in the staging UI.
function crmSafeAccessError(message,diagnosticCode) {
  // These are fixed diagnostic codes from an authenticated test-only check.
  // Never echo provider responses, keys, user identifiers or ledger records.
  const diagnostics = Object.freeze({
    site_record_missing: "The Netlify CRM website creation record is missing from the staging installer.",
    database_record_missing: "The test Supabase project creation record is missing from the installer.",
    schema_record_missing: "The test CRM database schema installation record is missing.",
    site_not_created: "The Netlify site creation is not marked completed in the installer.",
    site_name_mismatch: "The recorded CRM website name does not match the approved test site.",
    site_id_mismatch: "The recorded Netlify site ID differs from the approved test CRM website.",
    site_team_mismatch: "The CRM website was recorded under a different Netlify team.",
    site_owner_binding_mismatch: "The recorded CRM website belongs to a different staging account or organisation.",
    site_database_reference_mismatch: "The CRM website record is linked to a different Supabase project.",
    database_not_created: "The test Supabase project creation is not recorded as completed.",
    database_name_mismatch: "The recorded Supabase project name differs from the approved test project.",
    database_reference_mismatch: "The recorded Supabase project ID differs from the approved test database.",
    database_reference_invalid: "The recorded Supabase project ID is malformed.",
    runtime_reference_mismatch: "The undeployed CRM runtime source points to a different Supabase project than the verified installation records.",
    schema_not_applied: "The database schema installation has not been recorded as completed.",
    schema_database_reference_mismatch: "The CRM schema was recorded against a different Supabase database.",
    schema_version_mismatch: "The recorded CRM database schema version does not match the approved pilot.",
    linked_records_mismatch: "The database and hosting installation records disagree on additional security bindings.",
  });
  if (typeof diagnosticCode === "string" &&
      Object.hasOwn(diagnostics,diagnosticCode)) {
    return diagnostics[diagnosticCode] +
      " Deployment remains blocked until this is reviewed; no new project or account is needed.";
  }
  const messages = Object.freeze({
    "Staging only": "The request did not originate from the correct staging website.",
    "Secure staging portal unavailable": "The secure staging portal is temporarily unavailable.",
    "Secure session unavailable": "The staging session could not be checked.",
    "Reconnect your test account": "Your test Supabase connection has expired. Reconnect the test account.",
    "Session verification failed": "The staging session security token did not match. Refresh the page and recheck your connection.",
    "Only the approved test account can check its key": "The staging Supabase session is not the approved Klean.ly test account.",
    "Expected JSON request": "The browser sent an unexpected request format.",
    "Test installation record could not be verified": "The dedicated test CRM installation records could not be read.",
    "This request does not match the separate test CRM": "The test CRM project/site records do not match the approved pilot. This is NOT evidence that the key is incorrect.",
    "Enter only a Supabase publishable key": "Enter the sb_publishable_ key from the TEST Supabase project.",
    "The dedicated test Supabase could not verify this publishable key": "Supabase did not validate the key. Check the TEST project's API Keys page.",
    "The undeployed CRM source project reference requires review": "The installer database records match, but the CRM application source still references a different Supabase project. Do not enter a key or deploy until the runtime is corrected.",
  });
  return messages[message] || "The test CRM access check was unsuccessful. No credentials were stored.";
}
async function reviewCrmAccess() {
  if (crmAccessReviewPending || !oauthState.connected ||
      !netlifyState.connected || !oauthState.csrfToken) return;
  crmAccessReviewPending = true;
  renderProviders();
  const output = byId("crm-access-result");
  output.classList.remove("is-error", "is-warning");
  output.textContent = "Checking your existing staging session and pilot records…";
  try {
    const response = await fetch("/.netlify/functions/crm-publishable-key-review", {
      method: "POST", credentials: "same-origin", cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": oauthState.csrfToken,
      },
      body: JSON.stringify({ action: "preflight" }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(crmSafeAccessError(result?.error,result?.diagnosticCode));
    if (result?.mode !== "read_only_crm_publishable_key_review" ||
        !["staging_access_verified","runtime_reference_review_required"].includes(result?.state) ||
        result?.pilotAccessVerified !== true ||
        !/^[a-z0-9]{20}$/.test(result?.verifiedProjectRef || "") ||
        !/^[a-z0-9]{20}$/.test(result?.runtimeSourceProjectRef || "") ||
        typeof result?.runtimeSourceMatches !== "boolean" ||
        result?.publishableKeyVerified !== false ||
        result?.keyPersisted !== false ||
        result?.websiteDeployed !== false ||
        result?.deploymentApproved !== false ||
        result?.ownerCreated !== false ||
        result?.emailSent !== false ||
        (result.state === "staging_access_verified") !== result.runtimeSourceMatches) {
      throw new Error("The staging access response was incomplete.");
    }
    if (!result.runtimeSourceMatches) {
      output.classList.add("is-warning");
      output.textContent = "The original TEST website, Supabase project and CRM schema records MATCH. " +
        "Recorded test project: " + result.verifiedProjectRef + ". " +
        "The undeployed CRM code currently expects: " + result.runtimeSourceProjectRef + ". " +
        "The deployment is BLOCKED until the runtime code is corrected. " +
        "Don't enter the publishable key yet. No records were changed.";
    } else {
      output.textContent = "Staging access verified. The original site/database/schema records and the CRM source all match. " +
        "Test project: " + result.verifiedProjectRef + ". You may now verify the TEST Supabase publishable key. No changes were made.";
    }
  } catch (error) {
    output.classList.add("is-error");
    output.textContent = (error?.message || "Staging access could not be checked.") +
      " No public key is needed for this check. No website or database was modified.";
  } finally {
    crmAccessReviewPending = false;
    renderProviders();
  }
}

async function reviewCrmPublicKey(event) {
  event.preventDefault();
  if (crmPublicKeyPending || !oauthState.connected || !netlifyState.connected ||
      !oauthState.csrfToken) return;
  const key = byId("crm-public-key").value;
  if (!/^sb_publishable_[A-Za-z0-9_-]{16,200}$/.test(key)) return;

  crmPublicKeyPending = true;
  renderProviders();
  const output = byId("crm-public-key-result");
  output.classList.remove("is-error", "is-warning");
  output.textContent = "Checking the public key against your dedicated test Supabase…";
  try {
    const response = await fetch("/.netlify/functions/crm-publishable-key-review", {
      method: "POST", credentials: "same-origin", cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": oauthState.csrfToken,
      },
      body: JSON.stringify({ publishableKey: key }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(crmSafeAccessError(result?.error,result?.diagnosticCode));
    if (result.mode !== "read_only_crm_publishable_key_review" ||
        result.publishableKeyVerified !== true ||
        result.keyPersisted !== false ||
        result.websiteDeployed !== false ||
        result.ownerCreated !== false ||
        result.emailSent !== false ||
        !/^[a-f0-9]{12}$/.test(result.fingerprint || "")) {
      throw new Error("The verification response was incomplete. Your key was not saved.");
    }
    if (result.publicSignupsDisabled !== true) {
      output.classList.add("is-warning");
      output.textContent = "The test project accepted this public key, but public sign-ups are enabled. Disable public sign-ups before continuing. " +
        "The key was not saved, and the CRM was not deployed.";
      return;
    }
    output.textContent = "The test Supabase accepted your publishable key and public sign-ups are disabled. " +
      "Fingerprint: " + result.fingerprint + ". This key was NOT saved. " +
      "A separately approved deployment is still required; you may need to enter the publishable key again then.";
  } catch (error) {
    output.classList.add("is-error");
    output.textContent = (error?.message || "The key check was unavailable.") +
      " Nothing was saved or deployed. If this is a staging access issue, use Check staging access above before retrying your key.";
  } finally {
    byId("crm-public-key").value = "";
    crmPublicKeyPending = false;
    renderProviders();
  }
}

function safeCrmDeployMessage(state) {
  const messages=Object.freeze({
    deployment_locked: "This one-time CRM deployment is not enabled on staging.",
    test_account_not_connected: "Reconnect the test Supabase organisation in this staging installer.",
    session_verification_failed: "Refresh the staging page to renew the secure session.",
    test_owner_not_authorised: "The connected staging owner does not match the test business.",
    pilot_records_do_not_match: "The original test website, database and schema records do not match.",
    one_deploy_already_attempted: "A deployment attempt is already permanently recorded. Do not retry. Use Check deployment status.",
    wrong_test_netlify_owner: "The connected Netlify account is not the approved test account.",
    test_site_is_not_empty_or_free: "The test Netlify website is not confirmed empty on the Free Plan. No upload occurred.",
    test_publishable_key_or_auth_not_verified: "The test Supabase could not validate this publishable key and disabled public sign-ups.",
    test_provider_preflight_unavailable: "Could not verify the test accounts. No upload was attempted.",
    crm_package_not_ready: "The audited CRM ZIP package failed its safety review. No upload was attempted.",
    deployment_reservation_unavailable: "Could not reserve the one-time deployment. No upload was attempted.",
    deployment_submission_lock_missing: "Could not lock the one-time deployment. Do not retry.",
    deployment_outcome_unknown_manual_review: "Netlify may have received the deployment. Do not retry; manually inspect the test site.",
    deployment_record_manual_review: "The Netlify result needs review. Do not retry.",
    deployment_status_not_confirmed: "Could not confirm the Netlify deployment status. Check it in the test Netlify account.",
    one_deploy_record_unavailable: "The one-time deployment record is not available.",
    explicit_deployment_approval_required: "Confirm both boxes, the exact phrase and the publishable key.",
  });
  return messages[state] || "The deployment needs checking. Do not retry automatically.";
}
async function checkCrmAppDeploymentStatus() {
  if (crmDeployStatusPending || !oauthState.csrfToken) return;
  crmDeployStatusPending = true;
  renderProviders();
  const out=byId("crm-app-deploy-status");
  out.classList.remove("is-error","is-warning");
  out.textContent="Checking the one-time Netlify deployment record…";
  try {
    const response=await fetch("/.netlify/functions/crm-app-deploy-once?status=1",{
      method:"POST",credentials:"same-origin",cache:"no-store",
      headers:{"Content-Type":"application/json",
        "X-CSRF-Token":oauthState.csrfToken},
      body:"{}",
    });
    const data=await response.json();
    if (!response.ok || data?.mode!=="staging_exact_first_crm_deploy") {
      throw new Error(safeCrmDeployMessage(data?.state));
    }
    if(data.state==="not_attempted" && data.canSubmit===true) {
      out.textContent="No deployment has been submitted. The test deployment form can be used once.";
    }else{
      crmDeployAlreadyAttempted=true;
      if(data.state==="ready"){
        out.textContent="Test CRM deployment verified. Open https://kleanly-business-crm-pilot.netlify.app to inspect the live test application. No invitation or owner account was created.";
      }else if(data.state==="submitted"){
        out.classList.add("is-warning");
        out.textContent="Netlify has a recorded deployment in progress. Do not send another. You may use this READ-ONLY status button again.";
      }else{
        out.classList.add("is-warning");
        out.textContent="A one-time deployment record already exists ("+String(data.state)+"). It requires manual verification; do not redeploy.";
      }
    }
  }catch(e){
    out.classList.add("is-error");
    out.textContent=(e?.message||"The deployment record was unavailable.")+
      " The app was not deployed by this status check.";
  }finally{
    crmDeployStatusPending=false;
    renderProviders();
  }
}

async function submitOneCrmAppDeployment(event) {
  event.preventDefault();
  if(crmDeploySubmitPending || crmDeploySubmittedInThisTab ||
     crmDeployAlreadyAttempted || !oauthState.connected ||
     !netlifyState.connected || !oauthState.csrfToken ||
     !byId("crm-deploy-credits").checked || !byId("crm-deploy-one").checked ||
     byId("crm-deploy-phrase").value!=="DEPLOY ONE TEST CRM"){
    return;
  }
  const publishableKey=byId("crm-deploy-public-key").value;
  if(!/^sb_publishable_[A-Za-z0-9_-]{16,200}$/.test(publishableKey))return;
  if(!window.confirm("FINAL CONFIRMATION: Upload ONE CRM application to the EXISTING kleanly-business-crm-pilot.netlify.app site in the kleanlytest Free Plan team? This may consume Netlify credits. No owner account or invitation will be created. Automatic retries are prohibited.")) return;
  crmDeploySubmitPending=true;
  crmDeploySubmittedInThisTab=true; // Never allow another POST in this tab.
  renderProviders();
  const out=byId("crm-app-deploy-result");
  out.classList.remove("is-error","is-warning");
  out.textContent="Sending ONE controlled CRM deployment request. Do not refresh or resubmit.";
  try{
    const response=await fetch("/.netlify/functions/crm-app-deploy-once",{
      method:"POST",credentials:"same-origin",cache:"no-store",
      headers:{"Content-Type":"application/json","X-CSRF-Token":oauthState.csrfToken},
      body:JSON.stringify({
        confirmation:"DEPLOY ONE TEST CRM",
        acknowledgeCredits:true,
        acknowledgeOneDeploy:true,
        publishableKey,
      }),
    });
    const data=await response.json();
    if (!response.ok) throw new Error(safeCrmDeployMessage(data?.state));
    if(data.mode!=="staging_exact_first_crm_deploy" ||
       !["ready","submitted"].includes(data.state)||
       data.firstDeploymentOnly!==true || data.automaticRetryAllowed!==false ||
       data.ownerCreated!==false || data.emailSent!==false){
       throw new Error("Deployment response could not be verified. Do not retry.");
    }
    crmDeployAlreadyAttempted=true;
    if(data.state==="ready"){
      out.textContent="The first CRM deployment is LIVE on https://kleanly-business-crm-pilot.netlify.app. Login invitations are NOT active and no owner account was created.";
    }else{
      out.classList.add("is-warning");
      out.textContent="One deployment request was submitted. Netlify may still be processing it. Use Check deployment status; do NOT submit again.";
    }
  }catch(e){
    out.classList.add("is-error");
    out.textContent=(e?.message||"The one-time deployment outcome is uncertain.")+
      " No automatic retry is permitted. Check the Netlify test account before taking any further action.";
  }finally{
    byId("crm-deploy-public-key").value="";
    byId("crm-deploy-phrase").value="";
    crmDeploySubmitPending=false;
    renderProviders();
  }
}

async function reviewCrmPackageSource() {
  const button = byId("review-crm-package");
  if (button.disabled) return;
  const output = byId("crm-package-result");
  button.disabled = true;
  output.classList.remove("is-error", "is-warning");
  output.textContent = "Checking the CRM source package and release safety locks...";
  try {
    // Static, build-generated audit only. No OAuth token, Auth user, private
    // database key or Netlify/Supabase write endpoint is ever called here.
    const response = await fetch("/crm-release-audit.json", {
      method: "GET", credentials: "same-origin", cache: "no-store",
    });
    if (!response.ok) throw new Error("CRM source audit is not available");
    const review = await response.json();
    if (review.audit !== "source-only" ||
        review.sourceValidated !== true ||
        review.noPublishableKeyBundled !== true ||
        review.noSecretKeysBundled !== true ||
        review.siteId !== "c4632a28-a4b0-4e77-a54e-7a8bf05a8882" ||
        review.siteUrl !== "https://kleanly-business-crm-pilot.netlify.app" ||
        review.projectUrl !== "https://nlupgjwcyivepzggffss.supabase.co" ||
        review.filesChecked !== 9 ||
        !/^[0-9a-f]{64}$/.test(review.sourceHash || "") ||
        review.websiteDeployed !== false ||
        review.ownerInvitationSent !== false ||
        review.readyForSeparateDeploymentApproval !== false) {
      throw new Error("The CRM package did not pass its staging safety checks");
    }
    output.textContent = "CRM source package checked: nine approved files, exact test website and Supabase project, login callback and security headers validated. " +
      "Fingerprint: " + review.sourceHash.slice(0, 16) + "… " +
      "The package contains NO real API keys. The CRM is NOT deployed; owner invitations and database changes remain disabled. " +
      "Provider access and a separate deployment approval are still required.";
  } catch (error) {
    output.classList.add("is-error");
    output.textContent = (error?.message || "Unable to verify the source package.") +
      " No CRM website deployment or owner invitation was attempted.";
  } finally {
    button.disabled = false;
  }
}

async function reviewCrmDeploymentReadiness() {
  if (crmDeploymentReviewPending || !oauthState.connected ||
      !netlifyState.connected || !oauthState.csrfToken) return;
  crmDeploymentReviewPending = true;
  renderProviders();
  const output = byId("crm-deployment-result");
  output.classList.remove("is-error");
  output.classList.remove("is-warning");
  output.textContent = "Checking the dedicated test CRM website and deployment history (read-only)...";
  try {
    const response = await fetch("/.netlify/functions/crm-deployment-readiness", {
      method: "POST", credentials: "same-origin", cache: "no-store",
      headers: { "X-CSRF-Token": oauthState.csrfToken },
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "CRM deployment check unavailable.");
    if (data.mode !== "read_only_crm_deployment_readiness" ||
        data.siteVerified !== true ||
        data.siteUrl !== "https://kleanly-business-crm-pilot.netlify.app" ||
        data.teamSlug !== "kleanlytest" ||
        data.installedCrmSchema !== true ||
        typeof data.siteHasExistingDeployment !== "boolean" ||
        typeof data.gitRepositoryLinked !== "boolean" ||
        typeof data.confirmedFreePlan !== "boolean" ||
        data.crmAppPackageReady !== false ||
        data.deploymentEnabled !== false ||
        data.deploymentAttempted !== false ||
        data.websiteModified !== false ||
        data.appDeployed !== false ||
        data.ownerCreated !== false ||
        data.emailSent !== false) {
      throw new Error("The deployment check returned unexpected information.");
    }
    const summary = "Verified test CRM host: " + data.siteUrl + ". ";
    if (data.state === "empty_site_verified" &&
        data.confirmedFreePlan === true &&
        data.siteHasExistingDeployment === false &&
        data.gitRepositoryLinked === false &&
        data.readyToPrepareCrmPackage === true) {
      output.textContent = summary +
        "Netlify Free Plan verified. No deployment or GitHub repository is linked. " +
        "Your eight-table CRM database is installed separately. " +
        "Next: package and security-test the CRM web app, then request separate approval to deploy it. " +
        "No website files or login were created.";
    } else {
      output.classList.add("is-warning");
      output.textContent = summary +
        "The Netlify site needs review before we can prepare an automated CRM deployment. " +
        (data.note || "Deployment status has changed.") +
        " No deployment was attempted.";
    }
  } catch (error) {
    output.classList.add("is-error");
    output.textContent = (error?.message || "Deployment status unavailable.") +
      " No deployment was attempted.";
  } finally {
    crmDeploymentReviewPending = false;
    renderProviders();
  }
}

async function reviewOwnerAuthSetup() {
  if (ownerAuthReviewPending || !oauthState.connected ||
      !netlifyState.connected || !oauthState.csrfToken) return;
  ownerAuthReviewPending = true;
  renderProviders();
  const output = byId("owner-auth-setup-result");
  output.classList.remove("is-error");
  output.classList.remove("is-warning");
  output.textContent = "Checking the test owner's Supabase Auth settings and CRM hosting records (read-only)...";
  try {
    const response = await fetch("/.netlify/functions/crm-owner-auth-review", {
      method: "POST", credentials: "same-origin", cache: "no-store",
      headers: { "X-CSRF-Token": oauthState.csrfToken },
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Owner login configuration could not be checked.");
    if (data.mode !== "read_only_crm_owner_auth_setup" ||
        data.projectVerified !== true ||
        data.websiteVerified !== true ||
        data.ownerEmail !== "kleanlytest@gerball.co.uk" ||
        data.proposedLoginUrl !== "https://kleanly-business-crm-pilot.netlify.app" ||
        data.requiredCallbackUrl !==
          "https://kleanly-business-crm-pilot.netlify.app/auth/callback" ||
        data.invitationEnabled !== false ||
        data.ownerCreated !== false || data.emailSent !== false ||
        data.databaseModified !== false || data.websiteModified !== false ||
        data.writeAttempted !== false) {
      throw new Error("Unexpected Supabase owner login configuration response.");
    }
    const heading = "Proposed test business owner: " + data.ownerEmail +
      ". Dedicated CRM login: " + data.proposedLoginUrl +
      ". Required callback: " + data.requiredCallbackUrl + ". ";
    if (data.state === "auth_read_permission_required" &&
        data.authSettingsRead === false) {
      output.classList.add("is-warning");
      output.textContent = heading +
        "The connected Supabase OAuth grant does not have permission to read Auth settings. " +
        "A separate auth:read permission review is needed before proceeding. " +
        "No settings were changed and no email was sent.";
    } else if ((data.state === "auth_url_configuration_needed" ||
        data.state === "auth_settings_checked_waiting_for_crm_deploy") &&
        data.authSettingsRead === true &&
        typeof data.siteUrlCorrect === "boolean" &&
        typeof data.callbackAllowlisted === "boolean" &&
        typeof data.emailProviderEnabled === "boolean" &&
        typeof data.publicSignupsDisabled === "boolean" &&
        data.crmAppDeployed === false) {
      const summary = "Auth Site URL: " +
        (data.siteUrlCorrect ? "matches" : "needs configuration") +
        ". Exact callback allowlist: " +
        (data.callbackAllowlisted ? "configured" : "needs configuration") +
        ". Email sign-in: " +
        (data.emailProviderEnabled ? "enabled" : "not enabled") +
        ". Public sign-ups: " +
        (data.publicSignupsDisabled ? "disabled" : "not disabled") + ". ";
      if (data.state === "auth_url_configuration_needed") output.classList.add("is-warning");
      output.textContent = heading + summary +
        "The CRM app and login callback are NOT deployed. No invitation can be sent yet. " +
        "We'll separately approve any future configuration and invitation.";
    } else if (data.state === "existing_owner_review_required" ||
               data.state === "website_needs_review") {
      output.classList.add("is-warning");
      output.textContent = heading + (data.note || "Manual review required.") +
        " No invitation was sent.";
    } else {
      throw new Error("Owner login review needs additional verification.");
    }
  } catch (error) {
    output.classList.add("is-error");
    output.textContent = (error?.message || "Owner login review unavailable.") +
      " No invitation was sent.";
  } finally {
    ownerAuthReviewPending = false;
    renderProviders();
  }
}

async function previewInstallation() {
  if (installationPreviewPending || !oauthState.connected || !netlifyState.connected ||
      !oauthState.csrfToken) return;
  const output = byId("installation-plan-result");
  output.hidden = false;
  output.classList.remove("is-error");
  output.replaceChildren();
  appendInstallationParagraph(output, "Preparing your read-only installation preview...");
  installationPreviewPending = true;
  renderProviders();

  try {
    const blueprint = sanitiseSetup(draft);
    const response = await fetch("/.netlify/functions/installation-preview", {
      method: "POST", credentials: "same-origin", cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": oauthState.csrfToken,
      },
      body: JSON.stringify({ blueprint }),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data?.error || "Installation preview is temporarily unavailable.");
    }
    renderInstallationPreview(data);
  } catch (error) {
    output.hidden = false;
    output.classList.add("is-error");
    output.replaceChildren();
    appendInstallationParagraph(output,
      (error?.message || "Unable to preview installation.") +
      " Nothing was created or charged."
    );
  } finally {
    installationPreviewPending = false;
    renderProviders();
  }
}

async function checkFreeProjectCapacity() {
  if (freeCapacityPending || !oauthState.connected || !netlifyState.connected ||
      !oauthState.csrfToken) return;
  const output = byId("free-project-capacity-result");
  output.classList.remove("is-error");
  output.textContent = "Checking the Supabase organisation plan and existing projects. Nothing will be created...";
  freeCapacityPending = true;
  renderProviders();
  try {
    const response = await fetch("/.netlify/functions/free-project-capacity", {
      method: "POST", credentials: "same-origin", cache: "no-store",
      headers: { "X-CSRF-Token": oauthState.csrfToken },
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error((data.error || "Supabase capacity could not be checked.") +
        (data.code ? " (Reference: " + data.code + ")" : ""));
    }
    if (data.allowedToCreateProject !== false || data.projectCreated !== false ||
        data.chargesApproved !== false || !Number.isSafeInteger(data.visibleAccountProjects) ||
        !Number.isSafeInteger(data.thisOrganizationProjects)) {
      throw new Error("The server returned an unexpected project eligibility status.");
    }
    const prefix = data.freePlanConfirmed
      ? "Supabase confirms this organisation is on the Free Plan. "
      : "The organisation's Free Plan could not be confirmed. ";
    const count = "Projects visible to this account: " + data.visibleAccountProjects +
      " (" + data.thisOrganizationProjects + " in " + data.organizationName + "). ";
    const next = data.appearsWithinFreeLimit
      ? "This appears to be within the usual two-project limit, but availability is NOT guaranteed. "
      : "A free project slot is not currently confirmed. ";
    output.textContent = prefix + count + next +
      "No project was created, no payment approved, and automatic creation remains locked until you explicitly approve a test.";
  } catch (error) {
    output.classList.add("is-error");
    output.textContent = (error?.message || "Unable to check Supabase project capacity.") +
      " No project, website or charge was created.";
  } finally {
    freeCapacityPending = false;
    renderProviders();
  }
}


function updatePilotApprovalState() {
  const canSubmit = pilotProposal?.creationEnabled === true &&
    pilotProposal.candidateForSingleFreeProject === true &&
    !pilotProposal.existingAttempt &&
    !pilotCreationPending &&
    byId("pilot-accept-costs").checked &&
    byId("pilot-confirm-phrase").value === pilotProposal.confirmationPhrase;
  byId("create-test-project").disabled = !canSubmit;
}

function clearPilotProposal() {
  pilotProposal = null;
  byId("test-project-approval").hidden = true;
  byId("pilot-confirm-phrase").value = "";
  byId("pilot-accept-costs").checked = false;
  updatePilotApprovalState();
}

async function reviewTestProject() {
  if (pilotProposalPending || pilotCreationPending || !oauthState.connected ||
      !netlifyState.connected || !oauthState.csrfToken) return;
  pilotProposalPending = true;
  clearPilotProposal();
  renderProviders();
  const output = byId("test-project-proposal-result");
  output.classList.remove("is-error");
  output.classList.remove("is-warning");
  output.textContent = "Checking the test organisation and its one-project creation safeguards...";
  try {
    const response = await fetch("/.netlify/functions/test-project-proposal", {
      method: "POST", credentials: "same-origin", cache: "no-store",
      headers: { "X-CSRF-Token": oauthState.csrfToken },
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "The test project proposal is currently unavailable.");
    }
    if (data.mode !== "staging_one_project_pilot" ||
        data.noPaidAddonsRequested !== true ||
        data.needsExplicitConfirmation !== true ||
        typeof data.projectName !== "string" ||
        typeof data.organization !== "string" ||
        typeof data.regionSelection !== "string") {
      throw new Error("The server returned an unexpected test project proposal.");
    }

    const heading = "Supabase project: " + data.projectName +
      ". Organisation: " + data.organization +
      ". Region: " + data.regionSelection + ". ";
    const capacity = "Free Plan " + (data.freePlanVerified ? "verified" : "not verified") +
      "; projects visible to your account: " + data.visibleProjects + ". ";
    const disclaimer = "No paid add-ons will be requested, but Supabase makes the final quota, " +
      "region and billing decisions. Review only — no project was created. ";

    pilotProposal = data;
    if (data.existingAttempt) {
      output.classList.add("is-warning");
      const state = data.existingAttempt.status;
      output.textContent = heading + capacity + disclaimer +
        "An earlier test creation attempt already exists (status: " + state + "). " +
        "A second request is permanently blocked. " +
        (data.existingAttempt.projectRef
          ? "Supabase reference: " + data.existingAttempt.projectRef + ". "
          : "Check your Supabase projects before taking further action. ");
    } else if (!data.candidateForSingleFreeProject) {
      output.classList.add("is-warning");
      output.textContent = heading + capacity + disclaimer +
        "Free Plan eligibility has not been confirmed. Creation stays locked.";
    } else if (data.creationLocked || !data.creationEnabled) {
      output.classList.add("is-warning");
      output.textContent = heading + capacity + disclaimer +
        "One free test-project slot appears available. REAL CREATION IS LOCKED until " +
        "the staging pilot is enabled after your explicit approval.";
    } else {
      output.textContent = heading + capacity + disclaimer +
        "The test pilot is unlocked. To create a real project, acknowledge the " +
        "potential provider costs and type the confirmation phrase below.";
      byId("pilot-confirm-phrase-display").textContent = data.confirmationPhrase;
      byId("test-project-approval").hidden = false;
    }
  } catch (error) {
    pilotProposal = null;
    output.classList.add("is-error");
    output.textContent = (error?.message || "Unable to review the test project.") +
      " No project was created.";
  } finally {
    pilotProposalPending = false;
    updatePilotApprovalState();
    renderProviders();
  }
}

async function createOneTestProject(event) {
  event.preventDefault();
  if (pilotCreationPending || !pilotProposal?.creationEnabled ||
      !pilotProposal.candidateForSingleFreeProject || pilotProposal.existingAttempt ||
      byId("pilot-confirm-phrase").value !== pilotProposal.confirmationPhrase ||
      !byId("pilot-accept-costs").checked || !oauthState.csrfToken) {
    return;
  }
  if (!window.confirm(
    "FINAL CONFIRMATION: Send ONE real Supabase project creation request to " +
    pilotProposal.organization + "? This uses a Free Plan slot, but any provider costs " +
    "are governed by Supabase. No website will be created."
  )) return;

  pilotCreationPending = true;
  renderProviders();
  updatePilotApprovalState();
  const output = byId("test-project-create-result");
  output.classList.remove("is-error");
  output.textContent = "Submitting the single approved test project request. Do not refresh or click again...";
  try {
    const response = await fetch("/.netlify/functions/test-project-create", {
      method: "POST", credentials: "same-origin", cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": oauthState.csrfToken,
      },
      body: JSON.stringify({
        confirmation: pilotProposal.confirmationPhrase,
        acknowledgeProviderCharges: true,
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(
      (data.error || "Supabase creation could not be verified.") +
      (data.code ? " (" + data.code + ")" : "")
    );
    if (data.state !== "project_created" || data.projectCreated !== true ||
        !/^[a-z0-9]{20}$/i.test(data.projectRef) ||
        data.websiteCreated !== false || data.crmSchemaInstalled !== false) {
      throw new Error("Creation response could not be verified. Inspect the Supabase dashboard before attempting anything else.");
    }
    output.textContent = "One new staging Supabase project has been created: " +
      data.projectName + " (" + data.projectRef + "). No website or CRM schema has been installed. ";
    const link = document.createElement("a");
    link.href = "https://supabase.com/dashboard/project/" + data.projectRef;
    link.rel = "noopener noreferrer";
    link.target = "_blank";
    link.textContent = "Open the test project in Supabase ↗";
    output.append(link);
    byId("provisioning-readiness-result").textContent = "";
    byId("free-project-capacity-result").textContent = "";
    clearInstallationPreview();
  } catch (error) {
    output.classList.add("is-error");
    output.textContent = (error?.message || "The test creation request has an unknown result.") +
      " Do NOT try creating another project. Check the Supabase project list first.";
  } finally {
    pilotCreationPending = false;
    clearPilotProposal();
    renderProviders();
  }
}

refreshSupabaseOAuthStatus().then(refreshNetlifyOAuthStatus);
