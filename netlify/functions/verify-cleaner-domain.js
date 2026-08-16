import { createClient } from "@supabase/supabase-js";
import { resolveTxt, resolveCname } from "node:dns/promises";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function env(name) {
  return process.env[name] || "";
}

async function txtContains(hostname, expected) {
  try {
    const rows = await resolveTxt(hostname);
    return rows.map((parts) => parts.join("")).includes(expected);
  } catch {
    return false;
  }
}

async function cnameMatches(hostname) {
  try {
    const rows = await resolveCname(hostname);
    return rows.some((value) => value.toLowerCase().replace(/\.$/, "") === "main--findabincleaner.netlify.app");
  } catch {
    return false;
  }
}

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7) : "";
  if (!token) return json({ error: "Authentication required" }, 401);

  const supabaseUrl = env("SUPABASE_URL").replace(/\/$/, "");
  const anonKey = env("SUPABASE_ANON_KEY") || env("VITE_SUPABASE_ANON_KEY");
  const serviceKey = env("SUPABASE_SERVICE_ROLE") || env("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceKey) return json({ error: "Server configuration incomplete" }, 500);

  const authClient = createClient(supabaseUrl, anonKey, { auth: { persistSession: false } });
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  const { data: userData, error: userError } = await authClient.auth.getUser(token);
  const user = userData?.user;
  if (userError || !user) return json({ error: "Invalid session" }, 401);

  let payload;
  try {
    payload = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const domainId = String(payload?.domainId || "").trim();
  if (!domainId) return json({ error: "domainId required" }, 400);

  const { data: domainRow, error: domainError } = await admin
    .from("cleaner_domains")
    .select("id, cleaner_id, domain, verification_token, verified")
    .eq("id", domainId)
    .maybeSingle();
  if (domainError) return json({ error: domainError.message }, 500);
  if (!domainRow) return json({ error: "Domain not found" }, 404);

  const { data: cleaner, error: cleanerError } = await admin
    .from("cleaners")
    .select("id, user_id")
    .eq("id", domainRow.cleaner_id)
    .maybeSingle();
  if (cleanerError) return json({ error: cleanerError.message }, 500);
  if (!cleaner || cleaner.user_id !== user.id) return json({ error: "Not allowed" }, 403);

  const verificationHost = `_kleanly-verify.${domainRow.domain}`;
  const ownershipVerified = await txtContains(verificationHost, domainRow.verification_token);
  const trafficReady = await cnameMatches(domainRow.domain);

  if (ownershipVerified && !domainRow.verified) {
    const { error: updateError } = await admin
      .from("cleaner_domains")
      .update({ verified: true, verified_at: new Date().toISOString() })
      .eq("id", domainRow.id);
    if (updateError) return json({ error: updateError.message }, 500);
  }

  return json({
    verified: ownershipVerified || domainRow.verified,
    ownershipVerified,
    trafficReady,
    verificationHost,
    cnameTarget: "main--findabincleaner.netlify.app",
  });
};
