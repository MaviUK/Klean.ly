// SOURCE ONLY. Imports a trusted request's server-authenticated portal user.
// The table schema exists only in the PROPOSED SQL, not deployed automatically.
import {
  INVITE_INSTALL_KEY,BIND_INSTALL_KEY,PILOT_OWNER_EMAIL,PILOT_REF,UUID_RE,
} from "./first-owner-pilot.mjs";
import { getPortalDatabase } from "../netlify/functions/_lib/connection-store.mjs";

const VALID_KEYS = new Set([INVITE_INSTALL_KEY,BIND_INSTALL_KEY]);
const TABLE = "portal_test_crm_first_owner_operations";

function assertActor(actor) {
  if (!actor || typeof actor.user_id !== "string" ||
      typeof actor.organization_id !== "string" ||
      actor.user_id.length < 1 || actor.user_id.length > 128 ||
      actor.organization_id.length < 1 || actor.organization_id.length > 128 ||
      typeof actor.email !== "string" ||
      actor.email.toLowerCase() !== PILOT_OWNER_EMAIL ||
      actor.connection_status !== "connected") {
    throw new Error("staging_operator_not_verified");
  }
}
function verifyRequest(actor, key, requestId) {
  assertActor(actor);
  if (!VALID_KEYS.has(key) || !UUID_RE.test(requestId)) {
    throw new Error("invalid_staging_request");
  }
}
export function createOwnerPilotLedger(actor, {
  database = getPortalDatabase,
} = {}) {
  assertActor(actor);
  let client = null;
  async function query(sql, params) {
    const db = await database();
    if (!db || !db.pool || typeof db.pool.query !== "function") {
      throw new Error("audit_database_unavailable");
    }
    // No SQL is constructed using browser values. Parameterised queries only.
    return db.pool.query(sql, params);
  }
  return Object.freeze({
    async reserve({key,requestId,projectRef,ownerEmail}) {
      verifyRequest(actor,key,requestId);
      if (projectRef!==PILOT_REF || ownerEmail!==PILOT_OWNER_EMAIL) {
        throw new Error("different_owner_project");
      }
      const result=await query(
        "INSERT INTO " + TABLE + " (request_id, operation_key, user_id, organization_id, project_ref, owner_email, status) " +
        "VALUES ($1,$2,$3,$4,$5,$6,'reserved') ON CONFLICT DO NOTHING RETURNING request_id",
        [requestId,key,actor.user_id,actor.organization_id,PILOT_REF,PILOT_OWNER_EMAIL]
      );
      return {
        reserved:result.rows?.length===1 &&
          String(result.rows[0]?.request_id)===requestId,
        requestId:result.rows?.length===1 ? requestId : null,
      };
    },
    async markSubmitted({key,requestId}) {
      verifyRequest(actor,key,requestId);
      const result=await query(
        "UPDATE " + TABLE + " SET status='submitted',submitted_at=now(),updated_at=now() " +
        "WHERE request_id=$1 AND operation_key=$2 AND user_id=$3 AND organization_id=$4 " +
        "AND status='reserved' RETURNING request_id",
        [requestId,key,actor.user_id,actor.organization_id]
      );
      return result.rows?.length===1;
    },
    async settle({key,requestId,status}) {
      verifyRequest(actor,key,requestId);
      if ((key===INVITE_INSTALL_KEY && !["sent","unknown"].includes(status)) ||
          (key===BIND_INSTALL_KEY && !["applied","unknown"].includes(status))) {
        throw new Error("invalid_owner_ledger_transition");
      }
      const result=await query(
        "UPDATE " + TABLE + " SET status=$1,finished_at=now(),updated_at=now() " +
        "WHERE request_id=$2 AND operation_key=$3 AND user_id=$4 AND organization_id=$5 " +
        "AND status='submitted' RETURNING request_id",
        [status,requestId,key,actor.user_id,actor.organization_id]
      );
      return result.rows?.length===1;
    },
    async status(key) {
      assertActor(actor);
      if (!VALID_KEYS.has(key)) throw new Error("invalid_owner_operation_key");
      const result=await query(
        "SELECT status,approved_at,submitted_at,finished_at FROM " + TABLE +
        " WHERE operation_key=$1 AND user_id=$2 AND organization_id=$3 LIMIT 1",
        [key,actor.user_id,actor.organization_id]
      );
      return result.rows?.[0] ?? null;
    },
  });
}
