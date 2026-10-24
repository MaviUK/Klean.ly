// Isolated pilot release packager — NEVER invoked by the active installer
// build or Netlify deploy hooks. It writes a local review directory only.
// It does NOT upload to Netlify, send email, or run any database query.
import {readFile,mkdir,writeFile} from "node:fs/promises";
import {resolve,relative,join,isAbsolute} from "node:path";
import {createHash} from "node:crypto";

export const RELEASE_PILOT_SITE_ID = "c4632a28-a4b0-4e77-a54e-7a8bf05a8882";
export const RELEASE_PILOT_URL = "https://kleanly-business-crm-pilot.netlify.app";
export const RELEASE_PILOT_SUPABASE = "https://nlupgjwcyivepzgqffss.supabase.co";
export const RELEASE_CONTENT = Object.freeze([
  "_headers","_redirects","index.html","styles.css","app.mjs",
  "tenant.mjs","invite-link.mjs","invite-callback.mjs",
  "auth/callback/index.html",
]);

export function checkReleaseInput({siteId,siteUrl,projectUrl,publishableKey,approval}={}) {
  if (siteId!==RELEASE_PILOT_SITE_ID || siteUrl!==RELEASE_PILOT_URL ||
      projectUrl!==RELEASE_PILOT_SUPABASE ||
      !/^sb_publishable_[A-Za-z0-9_-]{16,200}$/.test(publishableKey ?? "") ||
      approval?.approvalPhrase!=="PREPARE ONE CRM TEST BUILD" ||
      approval?.separateDeploymentApprovalRequired!==true ||
      approval?.siteCreateAllowed!==false ||
      approval?.emailSendAllowed!==false) {
    throw new Error("crm_release_not_approved_or_wrong_target");
  }
  return Object.freeze({
    siteId:RELEASE_PILOT_SITE_ID,
    siteUrl:RELEASE_PILOT_URL,
    projectUrl:RELEASE_PILOT_SUPABASE,
    publishableKey,
  });
}

function safeOutputPath(root,child) {
  if (child.includes("\\") || child.startsWith("/") || child.split("/").includes("..")) {
    throw new Error("unsafe_package_path");
  }
  const target=resolve(root,child);
  const fromRoot=relative(root,target);
  if (!fromRoot || fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
    throw new Error("unsafe_package_path");
  }
  return target;
}

export async function preparePilotRelease({
  sourceDir,outputDir,siteId,siteUrl,projectUrl,publishableKey,approval,
  fsAdapter={readFile,mkdir,writeFile},
}={}) {
  const input=checkReleaseInput({siteId,siteUrl,projectUrl,publishableKey,approval});
  if(typeof sourceDir!=="string"||typeof outputDir!=="string"||
     !isAbsolute(sourceDir)||!isAbsolute(outputDir)||
     resolve(sourceDir)===resolve(outputDir)||
     ![
       "readFile","mkdir","writeFile",
     ].every(key=>typeof fsAdapter[key]==="function")) {
    throw new Error("crm_release_path_invalid");
  }
  const source=resolve(sourceDir),dest=resolve(outputDir);
  if(relative(source,dest).startsWith("..")===false &&
     relative(source,dest)!=="") {
    // Don't accidentally use nested .dist inside source and sweep extra files.
    throw new Error("crm_release_path_invalid");
  }
  const pending=[];
  for(const filename of RELEASE_CONTENT) {
    const bytes=await fsAdapter.readFile(safeOutputPath(source,filename));
    if(!(bytes instanceof Uint8Array) || bytes.byteLength===0 ||
       bytes.byteLength>600000) throw new Error("crm_source_integrity_invalid");
    pending.push({filename,bytes});
  }
  await fsAdapter.mkdir(dest,{recursive:true});
  const checksums={};
  for(const {filename,bytes} of pending) {
    const target=safeOutputPath(dest,filename);
    const parent=target.slice(0,target.lastIndexOf("/"));
    await fsAdapter.mkdir(parent,{recursive:true});
    await fsAdapter.writeFile(target,bytes,{flag:"wx"});
    checksums[filename]=createHash("sha256").update(bytes).digest("hex");
  }
  const publicConfig=JSON.stringify({
    projectUrl: input.projectUrl,
    siteUrl: input.siteUrl,
    publishableKey: input.publishableKey,
  },null,2)+"\n";
  await fsAdapter.writeFile(safeOutputPath(dest,"tenant-config.json"),publicConfig,{flag:"wx"});
  const hash=createHash("sha256").update(
    RELEASE_CONTENT.map(filename=>filename+":"+checksums[filename]).join("\n")
  ).digest("hex");
  return Object.freeze({
    packagePrepared:true,siteId:input.siteId,siteUrl:input.siteUrl,
    applicationFiles:RELEASE_CONTENT.length+1,sourceHash:hash,
    needsSeparateNetlifyDeployApproval:true,loginConfigured:true,
    ownerInvitationSent:false,ownerCreated:false,websiteDeployed:false,
  });
}
