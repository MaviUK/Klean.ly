// TEST CRM PILOT ONLY: create the exact Netlify-compatible, deterministic ZIP
// in memory. THIS MODULE DOES NOT DEPLOY OR PERSIST THE ZIP. Publishing
// requires a separately approved, connected, server-side Netlify workflow.
// A Supabase publishable key is public client configuration; never provide
// service-role credentials, provider OAuth tokens or private customer data.
import {createHash} from "node:crypto";
import {readFile,lstat} from "node:fs/promises";
import {resolve,relative,isAbsolute} from "node:path";
import {
  RELEASE_CONTENT, RELEASE_PILOT_URL, RELEASE_PILOT_SUPABASE,
  RELEASE_PILOT_SITE_ID, checkReleaseInput,
} from "./prepare-crm-release.mjs";
import {auditPilotReleaseSource} from "./audit-crm-release.mjs";

const ENTRY_SIZE_LIMIT=600000;
const ZIP_SIZE_LIMIT=3500000;
const BASE_ENTRY="tenant-config.json";

function fail(reason){throw new Error("crm_zip_preflight_failed:"+reason);}
function safePath(dir,child){
  if(typeof child!=="string" || child.includes("\\") ||
     child.startsWith("/") ||
     child.split("/").some(x=>!x || x==="." || x==="..")) fail("unsafe_path");
  const dest=resolve(dir,child);
  const relativeName=relative(dir,dest);
  if(!relativeName || relativeName.startsWith("..") || isAbsolute(relativeName)){
    fail("unsafe_path");
  }
  return dest;
}
function toBytes(content){
  if(!(Buffer.isBuffer(content)||content instanceof Uint8Array))fail("invalid_file");
  const data=Buffer.from(content);
  if(!data.length || data.length>ENTRY_SIZE_LIMIT)fail("invalid_size");
  return data;
}

function crc32(input){
  let crc=0xFFFFFFFF;
  for(const b of input){
    crc^=b;
    for(let n=0;n<8;n++)crc=(crc>>>1)^(crc&1?0xEDB88320:0);
  }
  return (crc^0xFFFFFFFF)>>>0;
}

// Stored ZIP entries avoid 3rd-party archive dependencies. We accept
// exactly nine audited source files plus one generated public JSON config.
// Zero DOS timestamps make the binary output reproducible.
export function encodePilotZip(entries){
  if(!Array.isArray(entries) || entries.length!==RELEASE_CONTENT.length+1)fail("incorrect_file_count");
  const exactFiles=new Set([...RELEASE_CONTENT,BASE_ENTRY]);
  const used=new Set(),locals=[],central=[];
  let offset=0,totalSize=0;
  for(const entry of entries){
    const filename=entry?.filename;
    if(typeof filename!=="string"||!exactFiles.has(filename)||used.has(filename)||
       filename.includes("\\") || filename.startsWith("/") ||
       filename.split("/").some(x=>!x || x==="." || x===".."))fail("unsafe_entry");
    used.add(filename);
    const content=toBytes(entry.bytes);
    totalSize+=content.length;
    if(totalSize>ZIP_SIZE_LIMIT)fail("too_large");
    const name=Buffer.from(filename,"utf8");
    const checksum=crc32(content);
    const local=Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50,0);
    local.writeUInt16LE(20,4); // ZIP version 2.0
    local.writeUInt16LE(0x800,6); // UTF-8
    local.writeUInt16LE(0,8); // STORE - no compression
    local.writeUInt32LE(checksum,14);
    local.writeUInt32LE(content.length,18);
    local.writeUInt32LE(content.length,22);
    local.writeUInt16LE(name.length,26);
    const directory=Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50,0);
    directory.writeUInt16LE(20,4);
    directory.writeUInt16LE(20,6);
    directory.writeUInt16LE(0x800,8);
    directory.writeUInt16LE(0,10);
    directory.writeUInt32LE(checksum,16);
    directory.writeUInt32LE(content.length,20);
    directory.writeUInt32LE(content.length,24);
    directory.writeUInt16LE(name.length,28);
    directory.writeUInt32LE(offset,42);
    locals.push(local,name,content);
    central.push(directory,name);
    offset+=local.length+name.length+content.length;
  }
  if(used.size!==exactFiles.size)fail("missing_approved_entry");
  const directoryBytes=Buffer.concat(central), end=Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50,0);
  end.writeUInt16LE(entries.length,8);
  end.writeUInt16LE(entries.length,10);
  end.writeUInt32LE(directoryBytes.length,12);
  end.writeUInt32LE(offset,16);
  const zip=Buffer.concat([...locals,directoryBytes,end]);
  if(zip.length>ZIP_SIZE_LIMIT)fail("too_large");
  return zip;
}

export async function buildOfflinePilotZip({
  sourceDir,siteId,siteUrl,projectUrl,publishableKey,approval,
  fs={lstat,readFile},
}={}){
  const input=checkReleaseInput({siteId,siteUrl,projectUrl,publishableKey,approval});
  if(typeof sourceDir!=="string"||!isAbsolute(sourceDir))fail("invalid_source");
  const root=resolve(sourceDir);
  const audit=await auditPilotReleaseSource(root,fs);
  if(audit.sourceValidated!==true||audit.noPublishableKeyBundled!==true||
     audit.noSecretKeysBundled!==true||
     audit.siteId!==RELEASE_PILOT_SITE_ID||
     audit.projectUrl!==RELEASE_PILOT_SUPABASE||
     audit.siteUrl!==RELEASE_PILOT_URL||
     audit.websiteDeployed!==false||
     audit.ownerInvitationSent!==false)fail("source_not_approved");

  const entries=[],files=[];
  for(const filename of RELEASE_CONTENT){
    const path=safePath(root,filename);
    const info=await fs.lstat(path);
    if(!info.isFile()||info.isSymbolicLink()||info.size>ENTRY_SIZE_LIMIT)fail("unsafe_asset");
    const bytes=toBytes(await fs.readFile(path));
    const sha=createHash("sha256").update(bytes).digest("hex");
    files.push(filename+":"+sha);
    entries.push({filename,bytes});
  }
  // A changed file between the source audit and this snapshot is rejected.
  const expected=createHash("sha256").update(files.join("\n")).digest("hex");
  if(expected!==audit.sourceHash)fail("source_changed_after_audit");

  const publicConfig={
    projectUrl:input.projectUrl,siteUrl:input.siteUrl,
    publishableKey:input.publishableKey,
  };
  const bytes=Buffer.from(JSON.stringify(publicConfig,null,2)+"\n","utf8");
  entries.push({filename:BASE_ENTRY,bytes});
  const zip=encodePilotZip(entries);
  return Object.freeze({
    archive:zip,
    archiveSha256:createHash("sha256").update(zip).digest("hex"),
    sourceHash:audit.sourceHash,
    fileCount:entries.length,
    archiveSize:zip.length,
    targetSiteId:siteId,
    targetUrl:siteUrl,
    deployAttempted:false,
    inviteSent:false,
    ownerCreated:false,
  });
}
