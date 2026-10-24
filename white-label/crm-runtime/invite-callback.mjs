import { parsePilotInviteLink } from "./invite-link.mjs";
import { createTenantClient } from "./tenant.mjs";

const byId = id => document.getElementById(id);
const status = byId("invite-status");
const accept = byId("accept-invite");
const form = byId("new-password-form");
let client = null;
let receivedInvite = null;
let waiting = false;

function update(message, failed = false) {
  status.textContent = message;
  status.classList.toggle("error", failed);
}

// Scrub invite hashes/codes BEFORE any network requests or async imports.
// The payload remains only in JavaScript memory, never browser storage.
// Do not consume tokens on this GET: email security scanners may prefetch.
try {
  receivedInvite = parsePilotInviteLink(window.location.href);
} catch {
  update("This invitation link is missing, expired or belongs to a different site.", true);
} finally {
  window.history.replaceState(null, "", "/auth/callback");
}

if (receivedInvite) {
  (async () => {
    try {
      const reply = await fetch("../../tenant-config.json", {
        credentials: "omit", cache: "no-store", redirect: "error",
      });
      if (!reply.ok) throw new Error("Configuration not provisioned");
      client = createTenantClient(await reply.json(), {
        browserOrigin: window.location.origin,
      });
      accept.hidden = false;
      update("Invitation detected. Tap Accept invitation to verify it securely.");
    } catch {
      receivedInvite = null;
      update("This pilot has not enabled secure owner invitations yet. No account was created.", true);
    }
  })();
}

accept.addEventListener("click", async () => {
  if (!client || !receivedInvite || waiting) return;
  waiting = true;
  accept.disabled = true;
  update("Verifying your invitation…");
  try {
    await client.acceptInvitation(receivedInvite);
    receivedInvite = null;  // an invite must never be retried or replayed
    accept.hidden = true;
    form.hidden = false;
    update("Invitation verified. Choose a strong password to finish your account setup.");
  } catch {
    receivedInvite = null;
    accept.hidden = true;
    update("The invitation could not be verified. Request a fresh invitation from your administrator.", true);
  } finally {
    waiting = false;
    accept.disabled = false;
  }
});

form.addEventListener("submit", async event => {
  event.preventDefault();
  if (!client || waiting) return;
  const password = byId("new-password").value;
  const confirmation = byId("confirm-password").value;
  if (password !== confirmation) {
    update("The passwords do not match.", true);
    return;
  }
  waiting = true;
  byId("save-password").disabled = true;
  update("Saving your password…");
  byId("new-password").value = "";
  byId("confirm-password").value = "";
  try {
    const result = await client.completeInvitationPassword(password);
    if (result.passwordSet !== true || result.ownerAssigned !== false) throw new Error("Unexpected setup state");
    form.hidden = true;
    update("Password saved. Your account cannot access any CRM records until your business owner role is separately assigned and verified.");
  } catch (error) {
    update(error instanceof Error ? error.message : "Password setup failed. Request a new invitation.", true);
  } finally {
    waiting = false;
    byId("save-password").disabled = false;
  }
});
