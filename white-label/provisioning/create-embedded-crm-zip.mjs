// Server-side staging ZIP packager. No fs/network I/O, no persistence,
// no private provider token or database access. Does not submit a deployment.
import {createHash} from "node:crypto";
import {EMBEDDED_CRM_FILES} from "../netlify/functions/_lib/crm-runtime-embedded.mjs";
import {
  checkReleaseInput,RELEASE_CONTENT,RELEASE_PILOT_SITE_ID,
  RELEASE_PILOT_SUPABASE,RELEASE_PILOT_URL,
} from "./prepare-crm-release.mjs";
import {encodePilotZip} from "./create-pilot-zip.mjs";

const EXPECTED_REF = new URL(RELEASE_PILOT_SUPABASE).hostname.split(".")[0];
export const ZIP_CONSENT_PHRASE = "DEPLOY ONE TEST CRM";
export const MAX_PUBLIC_KEY_SIZE = 240;
const DANGEROUS = [
  /\bsb_secret_[A-Za-z0-9_-]{16,}\b/,
  /\bSUPABASE_SERVICE_ROLE_KEY\s*[:=]/i,
  /\bNETLIFY_AUTH_TOKEN\s*[:=]/i,
];

export function buildEmbeddedCrmZip({publishableKey, approval, embedded=EMBEDDED_CRM_FILES}={}){
  // Caller must have separately checked ownership/session/provider identity.
  // The only client-supplied build value is a Supabase *publishable* key.
  const request=checkReleaseInput({
    siteId:RELEASE_PILOT_SITE_ID,
    siteUrl:RELEASE_PILOT_URL,
    projectUrl:RELEASE_PILOT_SUPABASE,
    publishableKey,approval,
  });
  if(!Array.isArray(embedded) || embedded.length!==RELEASE_CONTENT.length) {
    throw new Error("invalid_embedded_source");
  }
  const entries=[], parts=[];
  for(let i=0;i<RELEASE_CONTENT.length;i++){
    const entry=embedded[i];
    if(entry?.filename!==RELEASE_CONTENT[i] ||
       typeof entry?.source!=="string" ||
       !entry.source.length || entry.source.length>600000 ||
       DANGEROUS.some(x=>x.test(entry.source))) {
      throw new Error("invalid_embedded_source");
    }
    const bytes=Buffer.from(entry.source,"utf8");
    entries.push({filename:entry.filename,bytes});
    parts.push(entry.filename+":"+createHash("sha256").update(bytes).digest("hex"));
  }
  const sourceOf=(filename)=>embedded.find(e=>e.filename===filename)?.source||"";
  if(!sourceOf("tenant.mjs").includes('const PILOT_REF = "'+EXPECTED_REF+'"') ||
     !sourceOf("_headers").includes("connect-src 'self' "+RELEASE_PILOT_SUPABASE) ||
     !sourceOf("_headers").includes("X-Robots-Tag: noindex, nofollow") ||
     !sourceOf("_headers").includes("frame-ancestors 'none'") ||
     !sourceOf("_redirects").includes("/auth/callback /auth/callback/index.html 200") ||
     !sourceOf("app.mjs").includes("./tenant.mjs") ||
     !sourceOf("invite-callback.mjs").includes("./tenant.mjs")) {
    throw new Error("embedded_runtime_security_check_failed");
  }
  const config=Buffer.from(JSON.stringify({
    projectUrl:request.projectUrl,siteUrl:request.siteUrl,
    publishableKey:request.publishableKey,
  },null,2)+"\n","utf8");
  entries.push({filename:"tenant-config.json",bytes:config});
  const zip=encodePilotZip(entries);
  return Object.freeze({
    zip,sha256:createHash("sha256").update(zip).digest("hex"),
    sourceHash:createHash("sha256").update(parts.join("\n")).digest("hex"),
    fileCount:entries.length,
    siteId:request.siteId,
    siteUrl:request.siteUrl,
    uploaded:false,inviteSent:false,ownerCreated:false,
  });
}
