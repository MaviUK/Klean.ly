// Klean.ly Business — isolated, owner-only CRM browser transport.
// No tokens or session credentials persist to localStorage or cookies.
// The dedicated project's RLS remains the source of authorization.
const PILOT_REF = "nlupgjwcyivepzgqffss";
const PILOT_CRM_ORIGIN = "https://kleanly-business-crm-pilot.netlify.app";
const LIVE_DIRECTORY_HOSTS = new Set(["klean.ly", "www.klean.ly"]);
const VIEW_FIELDS = Object.freeze({
  customers: "id,full_name,phone,email,town,postcode,archived_at,created_at",
  rounds: "id,name,cadence_days,route_day,is_active,created_at",
  customer_services: "id,customer_id,service_name,next_visit_on,is_active",
  jobs: "id,scheduled_for,status,created_at",
  payments: "id,customer_id,amount_pence,currency,status,created_at",
  message_log: "id,channel,status,subject,sent_at,created_at",
  team_members: "id,display_name,role,is_active,created_at",
});
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function verifiedPilotClientConfig(config, browserOrigin = "") {
  if (!config || typeof config !== "object" || Array.isArray(config) ||
      typeof config.projectUrl !== "string" ||
      typeof config.siteUrl !== "string" ||
      typeof config.publishableKey !== "string") {
    throw new Error("CRM configuration is missing");
  }
  let project, site;
  try {
    project = new URL(config.projectUrl);
    site = new URL(config.siteUrl);
  } catch { throw new Error("CRM site configuration is invalid"); }
  if (project.href !== "https://" + PILOT_REF + ".supabase.co/" ||
      site.href !== PILOT_CRM_ORIGIN + "/" ||
      LIVE_DIRECTORY_HOSTS.has(site.hostname) ||
      (browserOrigin && browserOrigin !== site.origin) ||
      !/^sb_publishable_[a-zA-Z0-9_-]{16,200}$/.test(config.publishableKey)) {
    throw new Error("CRM configuration does not match this isolated pilot");
  }
  return Object.freeze({
    projectUrl: project.origin,
    siteUrl: site.origin,
    publishableKey: config.publishableKey,
  });
}

function apiError(response) {
  // Never reflect the provider response body — it may contain internal details.
  return response.status === 401 || response.status === 403
    ? new Error("Access denied. Sign in with the approved business owner.")
    : new Error("CRM service is unavailable. Try again.");
}

function safeIsoExpiry(session, now) {
  if (!session || typeof session.access_token !== "string" ||
      session.access_token.length < 24 ||
      typeof session.refresh_token !== "string" ||
      session.refresh_token.length < 8 ||
      (!Number.isFinite(session.expires_in) &&
       !Number.isFinite(session.expires_at))) {
    throw new Error("Could not verify the owner session");
  }
  const expiry = Number.isFinite(session.expires_at)
    ? session.expires_at * 1000 : now() + session.expires_in * 1000;
  if (!Number.isFinite(expiry) || expiry <= now()) {
    throw new Error("The owner session has expired");
  }
  return { accessToken: session.access_token, refreshToken: session.refresh_token, expiresAt: expiry };
}

export function createTenantClient(config, {
  fetchFn = fetch,
  now = Date.now,
  browserOrigin = "",
} = {}) {
  const target = verifiedPilotClientConfig(config, browserOrigin);
  let session = null;
  let owner = null;
  let activeUserId = null;
  let inProgressRefresh = null;

  async function send(path, { method = "GET", bearer = "", body } = {}) {
    const response = await fetchFn(target.projectUrl + path, {
      method, cache: "no-store", redirect: "error", credentials: "omit",
      headers: {
        apikey: target.publishableKey,
        ...(bearer ? { Authorization: "Bearer " + bearer } : {}),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw apiError(response);
    if (response.status === 204) return null;
    return response.json();
  }

  function clearSession() {
    session = null; owner = null; activeUserId = null; inProgressRefresh = null;
  }

  async function getVerifiedOwner(token) {
    const user = await send("/auth/v1/user", { bearer: token });
    if (!user || typeof user.id !== "string" || !/^[a-f0-9-]{36}$/i.test(user.id)) {
      throw new Error("Could not verify the signed-in user");
    }
    const rows = await send(
      "/rest/v1/business_profile?select=id,owner_user_id,business_name&limit=1",
      { bearer: token }
    );
    if (!Array.isArray(rows) || rows.length !== 1 || rows[0]?.id !== 1 ||
        rows[0]?.owner_user_id !== user.id ||
        typeof rows[0]?.business_name !== "string") {
      throw new Error("This account has not been assigned business owner access");
    }
    return { userId: user.id, businessName: rows[0].business_name };
  }

  async function login(email, password) {
    clearSession();
    if (typeof email !== "string" || !EMAIL.test(email.trim()) ||
        typeof password !== "string" || password.length < 1 || password.length > 2048) {
      throw new Error("Enter a valid email address and password");
    }
    // No sign-up or self-service invitation endpoint is exposed.
    const response = await send("/auth/v1/token?grant_type=password", {
      method: "POST", body: { email: email.trim(), password },
    });
    const issued = safeIsoExpiry(response, now);
    try {
      const verified = await getVerifiedOwner(issued.accessToken);
      session = issued;
      owner = { businessName: verified.businessName };
      activeUserId = verified.userId;
      return { businessName: verified.businessName };
    } catch (error) {
      clearSession();
      throw error;
    }
  }

  async function validBearer() {
    if (!owner || !session || !activeUserId) {
      throw new Error("Owner sign-in is required");
    }
    if (session.expiresAt > now() + 90000) return session.accessToken;
    // Serialize concurrent list requests to prevent refresh-token reuse.
    if (!inProgressRefresh) {
      inProgressRefresh = (async () => {
        const refreshed = await send("/auth/v1/token?grant_type=refresh_token", {
          method: "POST", body: { refresh_token: session.refreshToken },
        });
        const renewed = safeIsoExpiry(refreshed, now);
        const verified = await getVerifiedOwner(renewed.accessToken);
        if (verified.userId !== activeUserId) {
          throw new Error("Owner identity changed. Sign in again.");
        }
        session = renewed;
        owner = { businessName: verified.businessName };
        return renewed.accessToken;
      })().catch(error => {
        clearSession();
        throw error;
      }).finally(() => { inProgressRefresh = null; });
    }
    return inProgressRefresh;
  }

  async function list(table, { limit = 20, offset = 0 } = {}) {
    if (!Object.hasOwn(VIEW_FIELDS, table) ||
        !Number.isInteger(limit) || limit < 1 || limit > 30 ||
        !Number.isInteger(offset) || offset < 0 || offset > 10000) {
      throw new Error("Unsupported CRM query");
    }
    const bearer = await validBearer();
    const params = new URLSearchParams({
      select: VIEW_FIELDS[table],
      limit: String(limit), offset: String(offset),
    });
    const rows = await send("/rest/v1/" + table + "?" + params, { bearer });
    if (!Array.isArray(rows) || rows.length > limit) {
      throw new Error("CRM response could not be verified");
    }
    return rows;
  }

  async function logout() {
    const token = session?.accessToken;
    clearSession();
    if (token) {
      try {
        await send("/auth/v1/logout", { method: "POST", bearer: token });
      } catch { /* Local session already cleared; no credentials persist. */ }
    }
  }

  return Object.freeze({
    login, list, logout,
    isOwnerSignedIn: () => Boolean(session && owner),
    ownerName: () => owner?.businessName ?? null,
  });
}
