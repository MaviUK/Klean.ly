// SOURCE-ONLY. Never imported by the live installer or its deployed functions.
// First-owner operations must be compiled/wired only after a separate approval,
// authenticated server-only handler, and control-plane audit tables are in place.
// The trusted caller MUST fetch evidence from provider APIs, NOT user-supplied JSON.
import { randomUUID } from "node:crypto";

export const PILOT_REF = "nlupgjwcyivepzggffss";
export const PILOT_OWNER_EMAIL = "kleanlytest@gerball.co.uk";
export const PILOT_CRM_ORIGIN = "https://kleanly-business-crm-pilot.netlify.app";
export const PILOT_CALLBACK = PILOT_CRM_ORIGIN + "/auth/callback";
export const PILOT_OWNER_NAME = "Klean.ly test business";
export const INVITE_INSTALL_KEY = "pilot-first-owner-invite-v1";
export const BIND_INSTALL_KEY = "pilot-first-owner-bind-v1";
export const INVITE_CONFIRMATION = "SEND ONE TEST OWNER INVITATION";
export const BIND_CONFIRMATION = "ASSIGN ONE TEST CRM OWNER";
export const INVITATION_ENABLED_VAR = "KLEANLY_TEST_FIRST_OWNER_INVITE_ENABLED";
export const ASSIGNMENT_ENABLED_VAR = "KLEANLY_TEST_FIRST_OWNER_ASSIGN_ENABLED";
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function insist(value) {
  if (!value) throw new Error("first_owner_preflight_denied");
}
export function assertInvitePreflight(e) {
  insist(e && typeof e === "object" && !Array.isArray(e));
  // Each field is populated by a server-side read of the actual test provider.
  insist(e.projectRef === PILOT_REF && e.projectRegion === "eu-central-1" &&
    e.schemaVersion === 1 && e.crmTables === 8 && e.rlsTables === 8);
  insist(e.ownerProfiles === 0 && e.teamMembers === 0);
  insist(e.authUsersTotal === 0 && e.authUsersMatchingOwner === 0);
  insist(e.siteUrl === PILOT_CRM_ORIGIN && e.siteDeployed === true &&
    e.sitePubliclyReachable === true && e.liveLoginRouteVerified === true &&
    e.liveCallbackRouteVerified === true);
  insist(e.siteUrlMatchesAuth === true && e.exactCallbackAllowlisted === true &&
    e.publicSignupDisabled === true && e.emailSigninEnabled === true &&
    e.invitationTemplateInstalled === true && e.senderVerified === true);
  insist(e.linkedSiteTeamSlug === "kleanlytest" &&
    e.billingFreePlanVerified === true && e.noPaidAddons === true);
  return true;
}
export function assertAssignmentPreflight(e) {
  insist(e && typeof e === "object" && !Array.isArray(e));
  insist(e.projectRef === PILOT_REF && e.schemaVersion === 1 &&
    e.crmTables === 8 && e.rlsTables === 8);
  insist(e.ownerProfiles === 0 && e.teamMembers === 0);
  insist(e.invitationStatus === "sent" && e.invitationDestination === PILOT_OWNER_EMAIL);
  insist(e.authUsersTotal === 1 && e.authUsersMatchingOwner === 1);
  insist(e.invitedUserConfirmed === true && e.invitedUserHasPassword === true &&
    e.invitedUserHasSignedIn === true && e.invitedAtPresent === true);
  insist(e.callbackVerifiedOnLiveSite === true);
  return true;
}
function assertApproved({enabled, approval, phrase, requestId}) {
  insist(enabled === true);
  insist(approval && approval.securePortalSessionVerified === true &&
    approval.csrfVerified === true && approval.sameOrigin === true &&
    approval.operatorEmail === PILOT_OWNER_EMAIL &&
    approval.targetProjectRef === PILOT_REF &&
    approval.confirmation === phrase &&
    approval.explicitConsentRecorded === true);
  insist(UUID_RE.test(requestId));
}
export function safeOwnerAudit(result) {
  // No access tokens, provider bodies, Auth user UUIDs or email-link tokens
  // leave the provisioning layer. Never return raw provider errors.
  return Object.freeze({
    mode: "first_owner_staging_only",
    state: result,
    projectRef: PILOT_REF,
    ownerEmail: PILOT_OWNER_EMAIL,
    automaticRetry: false,
  });
}
function validateFunctions(deps, method) {
  for (const key of ["readEvidence","reserve","markSubmitted","settle",method]) {
    insist(typeof deps?.[key] === "function");
  }
}
function reserveReply(result, requestId) {
  // The control-plane database has a UNIQUE globally permanent attempt key.
  return !!(result?.reserved === true && result?.requestId === requestId);
}

// One irreversible email action. The owner role is NEVER assigned here.
export async function performOnePilotOwnerInvite({
  enabled = false,
  approval = null,
  deps = null,
  requestId = randomUUID(),
} = {}) {
  // All gates are before *any* provider call or reservation.
  assertApproved({enabled,approval,phrase:INVITE_CONFIRMATION,requestId});
  validateFunctions(deps, "sendInvitation");

  const proof = await deps.readEvidence();
  assertInvitePreflight(proof);

  // Once reserved, no further attempt can be reserved, even if the provider
  // times out or OAuth is disconnected and reconnected.
  const reserved = await deps.reserve({
    key: INVITE_INSTALL_KEY, requestId, projectRef:PILOT_REF,
    ownerEmail: PILOT_OWNER_EMAIL,
  });
  if (!reserveReply(reserved, requestId)) {
    return safeOwnerAudit("already_attempted_manual_review");
  }
  const locked = await deps.markSubmitted({key:INVITE_INSTALL_KEY,requestId});
  if (locked !== true) return safeOwnerAudit("manual_review_required");
  try {
    // The injected, SERVER-ONLY adapter uses Supabase Admin inviteUserByEmail.
    // It must never receive a browser key or dynamically chosen destination.
    const status = await deps.sendInvitation({
      projectRef: PILOT_REF,
      email: PILOT_OWNER_EMAIL,
      redirectTo: PILOT_CALLBACK,
    });
    if (status?.invitationSubmitted !== true) {
      throw new Error("provider_result_not_verified");
    }
    const persisted = await deps.settle({
      key:INVITE_INSTALL_KEY,requestId,status:"sent",
    });
    return safeOwnerAudit(persisted === true
      ? "invitation_submitted_once" : "manual_review_required");
  } catch {
    // Unknown delivery state is NOT permission to send again.
    try { await deps.settle({
      key:INVITE_INSTALL_KEY,requestId,status:"unknown",
    }); } catch {}
    return safeOwnerAudit("manual_review_required");
  }
}

// The owner/user ID is taken ONLY from the Auth users table in a privileged
// transaction, not from a browser or user_metadata. Must run once, after the
// recipient explicitly accepts the invitation and sets a password.
export const ASSIGN_FIRST_OWNER_SQL = String.raw`begin;
set local statement_timeout = '15000ms';
do $first_owner$
declare
  verified_uid uuid;
begin
  perform pg_advisory_xact_lock(hashtext('kleanly-first-owner-bind-v1'));

  if to_regclass('public.cleaners') is not null or
     to_regclass('public.business_customers') is not null then
    raise exception 'wrong_database';
  end if;
  if (select count(*) from kleanly_internal.schema_versions where version = 1) <> 1 then
    raise exception 'invalid_schema';
  end if;
  if (select count(*) from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relkind='r' and c.relrowsecurity
      and c.relname in ('business_profile','team_members','customers','rounds',
                        'customer_services','jobs','payments','message_log')) <> 8 then
    raise exception 'missing_row_security';
  end if;
  if exists(select 1 from public.business_profile) or
     exists(select 1 from public.team_members) then
    raise exception 'owner_already_present';
  end if;
  if (select count(*) from auth.users) <> 1 then
    raise exception 'unexpected_auth_users';
  end if;
  select id into strict verified_uid
  from auth.users
  where lower(email) = 'kleanlytest@gerball.co.uk'
    and invited_at is not null
    and email_confirmed_at is not null
    and last_sign_in_at is not null
    and encrypted_password is not null
    and length(encrypted_password) > 20;
  if verified_uid is null then
    raise exception 'owner_not_verified';
  end if;

  insert into public.business_profile (id, owner_user_id, business_name, support_email)
  values (1, verified_uid, 'Klean.ly test business', 'kleanlytest@gerball.co.uk');

  insert into public.team_members (user_id, display_name, role, is_active)
  values (verified_uid, 'Pilot Owner', 'owner', true);

  if (select count(*) from public.business_profile b
        join public.team_members t on t.user_id = b.owner_user_id
        where b.id=1 and t.role='owner' and t.is_active) <> 1 then
    raise exception 'binding_mismatch';
  end if;
end
$first_owner$;
commit;`;

export const VERIFY_FIRST_OWNER_SQL = [
  "select",
  "(select count(*) from public.business_profile) as profile_count,",
  "(select count(*) from public.team_members) as member_count,",
  "(select count(*) from public.business_profile b join public.team_members t",
  "on t.user_id=b.owner_user_id where b.id=1 and t.role='owner' and t.is_active",
  "and exists (select 1 from auth.users u where u.id=b.owner_user_id",
  "and lower(u.email)='kleanlytest@gerball.co.uk' and u.email_confirmed_at is not null))",
  "as verified_binding_count",
].join(" ");

export function inspectOwnerBindingRows(raw) {
  const rows = Array.isArray(raw) ? raw : Array.isArray(raw?.result) ? raw.result : null;
  insist(rows?.length === 1);
  const row=rows[0];
  for (const k of ["profile_count","member_count","verified_binding_count"]) {
    insist(row && /^(0|[1-9][0-9]*)$/.test(String(row[k])));
  }
  return row.profile_count == 1 && row.member_count == 1 &&
    row.verified_binding_count == 1;
}

export async function performOnePilotOwnerAssignment({
  enabled = false, approval = null, deps = null,
  requestId = randomUUID(),
} = {}) {
  assertApproved({enabled,approval,phrase:BIND_CONFIRMATION,requestId});
  validateFunctions(deps,"executeSql");
  insist(typeof deps.verifyBinding === "function");
  const evidence = await deps.readEvidence();
  assertAssignmentPreflight(evidence);
  const reserved = await deps.reserve({
    key:BIND_INSTALL_KEY,requestId,projectRef:PILOT_REF,
    ownerEmail:PILOT_OWNER_EMAIL,
  });
  if (!reserveReply(reserved,requestId)) {
    return safeOwnerAudit("already_attempted_manual_review");
  }
  const locked = await deps.markSubmitted({key:BIND_INSTALL_KEY,requestId});
  if (locked !== true) return safeOwnerAudit("manual_review_required");

  try {
    const executed = await deps.executeSql({
      projectRef:PILOT_REF,query:ASSIGN_FIRST_OWNER_SQL,
    });
    if (executed?.submitted !== true) {
      throw new Error("sql_not_confirmed");
    }
    const rows = await deps.verifyBinding({
      projectRef:PILOT_REF, query:VERIFY_FIRST_OWNER_SQL,readOnly:true,
    });
    if (!inspectOwnerBindingRows(rows)) throw new Error("binding_not_verified");
    const saved=await deps.settle({key:BIND_INSTALL_KEY,requestId,status:"applied"});
    return safeOwnerAudit(saved===true
      ? "first_owner_verified" : "manual_review_required");
  } catch {
    try { await deps.settle({
      key:BIND_INSTALL_KEY,requestId,status:"unknown",
    }); } catch {}
    return safeOwnerAudit("manual_review_required");
  }
}
