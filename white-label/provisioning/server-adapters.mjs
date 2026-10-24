// TEST-PILOT SOURCE ONLY: future backend-only adapters.
// This module is not referenced by any published Netlify function.
// Credentials belong exclusively in a trusted server runtime, never HTML,
// browser config, an OAuth consent URL or the ChatGPT conversation.
import {
  PILOT_REF,PILOT_OWNER_EMAIL,PILOT_CALLBACK,
  ASSIGN_FIRST_OWNER_SQL,VERIFY_FIRST_OWNER_SQL,
} from "./first-owner-pilot.mjs";

export const READ_PILOT_AUTH_USERS_SQL = [
  "select",
  "count(*) as total_users,",
  "count(*) filter (where lower(email)='kleanlytest@gerball.co.uk') as matching_owner,",
  "count(*) filter (where lower(email)='kleanlytest@gerball.co.uk'",
  "and invited_at is not null and email_confirmed_at is not null",
  "and last_sign_in_at is not null",
  "and encrypted_password is not null and length(encrypted_password)>20)",
  "as completed_owner",
  "from auth.users",
].join(" ");

export function parsePilotAuthUsers(payload) {
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.result)
    ? payload.result : null;
  if (!rows || rows.length!==1 || !rows[0]) throw new Error("auth_users_unavailable");
  const values = ["total_users","matching_owner","completed_owner"].map(key=>{
    const raw=rows[0][key];
    if (!/^(0|[1-9][0-9]*)$/.test(String(raw)) ||
        !Number.isSafeInteger(Number(raw))) {
      throw new Error("auth_users_unavailable");
    }
    return Number(raw);
  });
  if (values[1]>values[0] || values[2]>values[1]) {
    throw new Error("auth_users_unavailable");
  }
  return Object.freeze({
    authUsersTotal: values[0],
    authUsersMatchingOwner: values[1],
    invitedUserConfirmed: values[2]===1,
    invitedUserHasPassword: values[2]===1,
    invitedUserHasSignedIn: values[2]===1,
    invitedAtPresent: values[2]===1,
  });
}

function ensureProject(ref) {
  if (ref !== PILOT_REF) throw new Error("wrong_provider_project");
}
function createReadResponseFailure(code) {
  // Never reflect confidential provider responses, SQL errors or tokens.
  throw new Error(code);
}

export function createPilotManagementAdapter({
  getAccessToken,fetchFn=fetch,
} = {}) {
  if (typeof getAccessToken!=="function" || typeof fetchFn!=="function") {
    throw new Error("missing_server_management_adapter");
  }
  async function managementSql(ref,sql,readOnly) {
    ensureProject(ref);
    if (![
      ASSIGN_FIRST_OWNER_SQL,
      VERIFY_FIRST_OWNER_SQL,
      READ_PILOT_AUTH_USERS_SQL,
    ].includes(sql)) throw new Error("unauthorised_management_sql");
    if (sql===ASSIGN_FIRST_OWNER_SQL && readOnly===true) {
      throw new Error("owner_write_confused_with_read");
    }
    if (sql!==ASSIGN_FIRST_OWNER_SQL && readOnly!==true) {
      throw new Error("read_only_requirement");
    }
    const access = await getAccessToken();
    if (typeof access !=="string" || access.length<8 || access.length>8192) {
      throw new Error("invalid_provider_grant");
    }
    const response=await fetchFn(
      "https://api.supabase.com/v1/projects/"+PILOT_REF+"/database/query",
      {
        method:"POST",
        headers:{ Authorization:"Bearer "+access,Accept:"application/json",
          "Content-Type":"application/json" },
        body:JSON.stringify({query:sql,...(readOnly?{read_only:true}:{})}),
        signal:AbortSignal.timeout(20000),
      }
    );
    if (!response.ok) return createReadResponseFailure("provider_query_rejected");
    return response.json();
  }

  return Object.freeze({
    async inspectAuthUsers({projectRef,readOnly=true}={}) {
      return parsePilotAuthUsers(await managementSql(
        projectRef,READ_PILOT_AUTH_USERS_SQL,readOnly
      ));
    },
    async executeSql({projectRef,query}={}) {
      const output=await managementSql(projectRef,query,false);
      // Query endpoint must have returned an HTTP-success response. Do not
      // interpret a body as proof of binding; verify it in a separate read.
      if (!Array.isArray(output) &&
          !Array.isArray(output?.result) &&
          !Array.isArray(output?.data)) {
        throw new Error("management_write_response_unverified");
      }
      return {submitted:true};
    },
    async verifyBinding({projectRef,query,readOnly}={}) {
      return managementSql(projectRef,query,readOnly);
    },
  });
}

export function createPilotInviteAdminAdapter({
  adminClient, adminProjectRef,
} = {}) {
  ensureProject(adminProjectRef);
  if (!adminClient || typeof adminClient.auth?.admin?.inviteUserByEmail!=="function") {
    throw new Error("server_admin_client_required");
  }
  // REQUIREMENT: the trusted caller MUST initialize this SDK client with
  // a dedicated TEST project's server-only secret, never with a publishable
  // browser key or the Supabase Management OAuth access token.
  return async function sendInvitation({projectRef,email,redirectTo}={}) {
    ensureProject(projectRef);
    if (email!==PILOT_OWNER_EMAIL || redirectTo!==PILOT_CALLBACK) {
      throw new Error("different_invitation_destination");
    }
    const result=await adminClient.auth.admin.inviteUserByEmail(
      PILOT_OWNER_EMAIL,{redirectTo:PILOT_CALLBACK}
    );
    if (result?.error || result?.data?.user?.email?.toLowerCase()!==PILOT_OWNER_EMAIL) {
      throw new Error("admin_invitation_unverified");
    }
    // Submission is NOT a promise that the message reached the mailbox.
    return {invitationSubmitted:true};
  };
}
