#!/usr/bin/env node
// Operator pilot installer: schema only. Never exposes access tokens to browsers.
import { readFile } from "node:fs/promises";

const MIGRATION_URL = new URL("../blueprint/0001_foundation.sql", import.meta.url);
const API_BASE = "https://api.supabase.com/v1";
const REF_PATTERN = /^[a-z]{20}$/i;

export function parseArgs(argv) {
  const options = { ref: "", apply: false, confirm: "", help: false };
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    if (item === "--help" || item === "-h") options.help = true;
    else if (item === "--apply") options.apply = true;
    else if ((item === "--ref" || item === "--confirm") && argv[i + 1]) {
      options[item === "--ref" ? "ref" : "confirm"] = argv[++i];
    } else throw new Error("Unrecognised argument: " + item);
  }
  return options;
}

export function validateProject(ref, projectName = "") {
  if (!REF_PATTERN.test(ref)) throw new Error("Expected a 20-letter Supabase project ref.");
  const protectedName = projectName.trim().toLowerCase().replace(/[\s_-]/g, "");
  if (protectedName === "klean.ly" || protectedName === "kleanly" || protectedName.includes("findabincleaner")) {
    throw new Error("Refusing to install in the Klean.ly directory project. Create a dedicated business project first.");
  }
}

export function validateBlueprint(sql) {
  if (!sql.includes("Dedicated database required: this database has the Klean.ly directory cleaners table.")) {
    throw new Error("Database safety guard is missing from the blueprint.");
  }
  if (!sql.includes("alter table public.customers enable row level security") &&
      !sql.includes("foreach target in array")) {
    throw new Error("RLS setup is missing from the blueprint.");
  }
  if (/drop\s+table\b/i.test(sql)) throw new Error("Blueprint may not drop existing tables.");
}

export function parseApiRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.result)) return payload.result;
  if (payload && Array.isArray(payload.data)) return payload.data;
  return [];
}

async function apiRequest(path, token, options = {}) {
  const response = await fetch(API_BASE + path, {
    method: options.method || "GET",
    headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json", "Accept": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(45000)
  });
  if (!response.ok) {
    // Avoid printing opaque provider errors, which can sometimes contain credentials.
    throw new Error("Supabase Management API returned HTTP " + response.status +
      ". Check project permissions, billing and API availability in the Supabase dashboard.");
  }
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

export async function main(args = process.argv.slice(2)) {
  const opts = parseArgs(args);
  if (opts.help) {
    console.log("Usage: node provisioner/install.mjs --ref PROJECT_REF [--apply --confirm PROJECT_REF]");
    console.log("Without --apply, this command only validates the local database blueprint.");
    return;
  }
  validateProject(opts.ref);
  const sql = await readFile(MIGRATION_URL, "utf8");
  validateBlueprint(sql);
  console.log("White-label database blueprint v1: " + sql.length + " bytes.");
  console.log("Target Supabase project ref: " + opts.ref);

  if (!opts.apply) {
    console.log("DRY RUN ONLY. No network calls or database changes were made.");
    console.log("Before applying: use a NEW project that belongs to this company, not the directory.");
    return;
  }
  if (opts.confirm !== opts.ref) {
    throw new Error("To apply, pass --confirm with the exact project ref shown above.");
  }
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  if (!token) {
    throw new Error("SUPABASE_ACCESS_TOKEN must be provided in the operator's secure environment.");
  }

  const project = await apiRequest("/projects/" + opts.ref, token);
  validateProject(opts.ref, typeof project.name === "string" ? project.name : "");
  if (project.status !== "ACTIVE_HEALTHY") {
    throw new Error("Target project is not ACTIVE_HEALTHY. Wait for it to finish provisioning.");
  }
  console.log("Project validated. Applying schema only to this dedicated project...");
  await apiRequest("/projects/" + opts.ref + "/database/query", token, {
    method: "POST", body: { query: sql }
  });

  const check = await apiRequest("/projects/" + opts.ref + "/database/query", token, {
    method: "POST",
    body: {
      query: "select (to_regclass('public.business_profile') is not null) as profile_ok, " +
        "(to_regclass('public.customers') is not null) as customers_ok, " +
        "(to_regclass('public.jobs') is not null) as jobs_ok, " +
        "coalesce((select relrowsecurity from pg_class where oid=to_regclass('public.customers')),false) as customer_rls, " +
        "(select count(*) from kleanly_internal.schema_versions where version=1) as migration_recorded;"
    }
  });
  const row = parseApiRows(check)[0];
  if (!row || !row.profile_ok || !row.customers_ok || !row.jobs_ok || !row.customer_rls || Number(row.migration_recorded) !== 1) {
    throw new Error("Schema may have been applied, but verification did not confirm all expected tables and RLS.");
  }
  console.log("Verified schema v1, including customer RLS. No business owner or test customer was created.");
}

if (process.argv[1] && new URL("file://" + process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error("Installation stopped: " + (error instanceof Error ? error.message : "Unknown error"));
    process.exitCode = 1;
  });
}
