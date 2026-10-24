import { createTenantClient } from "./tenant.mjs";

const byId = id => document.getElementById(id);
const form = byId("login-form");
const status = byId("login-message");
const sectionStatus = byId("records-status");
const menu = [...document.querySelectorAll("[data-section]")];
const labels = Object.freeze({
  customers: ["Customers", "Contacts and addresses", r => [r.full_name, [r.town, r.postcode].filter(Boolean).join(" · "), r.phone]],
  rounds: ["Cleaning rounds", "Recurring schedules", r => [r.name, "Every " + r.cadence_days + " days", r.is_active ? "Active" : "Paused"]],
  customer_services: ["Services", "Customer service subscriptions", r => [r.service_name, r.next_visit_on ? "Next visit: " + r.next_visit_on : "No visit set", r.is_active ? "Active" : "Paused"]],
  jobs: ["Jobs", "Cleaning visits", r => [r.scheduled_for, r.status, "Job record"]],
  payments: ["Payments", "Read-only payment history", r => [r.currency === "GBP" && Number.isSafeInteger(r.amount_pence) ? "£" + (r.amount_pence / 100).toFixed(2) : "Payment", r.status, r.created_at?.slice(0, 10)]],
  message_log: ["Messages", "Read-only delivery history", r => [r.subject || r.channel, r.status, r.sent_at?.slice(0, 10)]],
  team_members: ["Team", "Invited company members", r => [r.display_name, r.role, r.is_active ? "Active" : "Inactive"]],
});
let client = null;
let current = "customers";
let offset = 0;
let sequence = 0;
let loading = false;
const pageSize = 20;

function setMessage(node, message, failed = false) {
  node.textContent = message;
  node.classList.toggle("error", failed);
}
function clearRecords() {
  byId("record-list").replaceChildren();
  byId("load-more").hidden = true;
}
function recordCard(fields) {
  const item = document.createElement("article");
  item.className = "record";
  fields.forEach((value, i) => {
    const node = document.createElement(i === 0 ? "strong" : "span");
    node.textContent = String(value ?? "—");
    item.appendChild(node);
  });
  return item;
}
async function loadRecords(clear = true) {
  if (!client?.isOwnerSignedIn() || loading) return;
  const token = ++sequence;
  const table = current;
  if (clear) { offset = 0; clearRecords(); }
  loading = true;
  byId("reload-records").disabled = true;
  byId("load-more").disabled = true;
  setMessage(sectionStatus, "Checking your private records…");
  try {
    const rows = await client.list(table, { limit: pageSize, offset });
    if (token !== sequence) return;
    for (const item of rows) byId("record-list").appendChild(recordCard(labels[table][2](item)));
    offset += rows.length;
    setMessage(sectionStatus, rows.length ? "Only the signed-in owner can access these records." :
      offset === 0 ? "No records yet in this section." : "No more records.");
    byId("load-more").hidden = rows.length < pageSize;
  } catch (error) {
    if (token !== sequence) return;
    setMessage(sectionStatus, error?.message || "Unable to load records.", true);
    byId("load-more").hidden = true;
  } finally {
    loading = false;
    byId("reload-records").disabled = false;
    byId("load-more").disabled = false;
  }
}
async function showSection(section) {
  if (!Object.hasOwn(labels, section)) return;
  sequence++;
  current = section;
  for (const item of menu) item.classList.toggle("active", item.dataset.section === section);
  byId("records-heading").textContent = labels[section][0];
  byId("records-description").textContent = labels[section][1];
  await loadRecords();
}
async function signOut() {
  sequence++;
  if (client) await client.logout();
  byId("workspace").hidden = true;
  byId("login-screen").hidden = false;
  form.hidden = false;
  clearRecords();
  byId("owner-password").value = "";
  setMessage(status, "Signed out of the private CRM.");
}
form.addEventListener("submit", async event => {
  event.preventDefault();
  if (!client) return;
  byId("login-button").disabled = true;
  setMessage(status, "Verifying your owner access…");
  const password = byId("owner-password").value;
  byId("owner-password").value = "";
  try {
    const info = await client.login(byId("owner-email").value, password);
    byId("business-title").textContent = info.businessName;
    form.hidden = true;
    byId("login-screen").hidden = true;
    byId("workspace").hidden = false;
    await showSection("customers");
  } catch (error) {
    setMessage(status, error?.message || "Sign-in unavailable.", true);
  } finally {
    byId("login-button").disabled = false;
  }
});
byId("sign-out").addEventListener("click", signOut);
byId("reload-records").addEventListener("click", () => loadRecords());
byId("load-more").addEventListener("click", () => loadRecords(false));
for (const button of menu) button.addEventListener("click", () => showSection(button.dataset.section));
(async () => {
  try {
    // This file intentionally does not ship with the source. A vetted,
    // public-key-only config is generated after separate deploy approval.
    const response = await fetch("./tenant-config.json", {
      cache: "no-store", credentials: "omit", redirect: "error",
    });
    if (!response.ok) throw new Error("The pilot CRM is not provisioned for login yet.");
    const settings = await response.json();
    client = createTenantClient(settings, { browserOrigin: window.location.origin });
    form.hidden = false;
    setMessage(status, "Secure pilot configuration verified. Sign in with your invited owner account.");
  } catch {
    form.hidden = true;
    setMessage(status, "Owner login is not enabled yet. The separate CRM deployment and first-owner invitation still require approval.");
  }
})();
