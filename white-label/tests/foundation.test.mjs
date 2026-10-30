import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { providers, requiredProviderIds, sanitiseSetup } from "../installer/catalog.mjs";
import { parseArgs, validateBlueprint, validateProject, parseApiRows } from "../provisioner/install.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

test("provider IDs are distinct and infrastructure is required", () => {
  assert.equal(new Set(providers.map((p) => p.id)).size, providers.length);
  assert.ok(requiredProviderIds.includes("supabase"));
  assert.ok(requiredProviderIds.includes("netlify"));
  assert.ok(providers.some((p) => p.id === "google_maps"));
  assert.ok(providers.some((p) => p.id === "resend"));
});

test("exported manifest strips invalid URLs, unknown providers and secret input", () => {
  const result = sanitiseSetup({
    name: "  NI Bin Guy  ", domain: "nibinguy.co.uk",
    primaryColor: "red", logoUrl: "javascript:alert(1)",
    desiredProviders: ["stripe", "not_a_provider", "stripe"],
    service_role: "NEVER_COPY_THIS"
  });
  assert.equal(result.company.name, "NI Bin Guy");
  assert.equal(result.company.logoUrl, "");
  assert.equal(result.company.primaryColor, "#059669");
  assert.deepEqual(result.desiredProviders, ["stripe"]);
  assert.equal(JSON.stringify(result).includes("NEVER_COPY_THIS"), false);
});

test("blueprint refuses application to directory and enables RLS", () => {
  const content = readFileSync(fileURLToPath(new URL("../blueprint/0001_foundation.sql", import.meta.url)), "utf8");
  validateBlueprint(content);
  assert.match(content, /to_regclass\('public\.cleaners'\)/);
  assert.match(content, /enable row level security/i);
  assert.match(content, /revoke all .* anon, authenticated/i);
  assert.doesNotMatch(content, /drop\s+table\b/i);
});

test("explicit confirmation and project ref checks", () => {
  const ref = "abcdefghijklmnopqrst";
  assert.deepEqual(parseArgs(["--ref", ref, "--apply", "--confirm", ref]), {ref,apply:true,confirm:ref,help:false});
  assert.throws(() => validateProject("INVALID!"));
  assert.throws(() => validateProject(ref, "Klean.ly"));
  assert.throws(() => validateProject(ref, "findabincleaner"));
});

test("Management API response row normalisation", () => {
  assert.deepEqual(parseApiRows([{ a: 1 }]), [{ a: 1 }]);
  assert.deepEqual(parseApiRows({ result: [{ a: 1 }] }), [{ a: 1 }]);
  assert.deepEqual(parseApiRows(null), []);
});

test("dry-run performs no network access and needs no secrets", () => {
  const script = fileURLToPath(new URL("../provisioner/install.mjs", import.meta.url));
  const proc = spawnSync(process.execPath, [script, "--ref", "abcdefghijklmnopqrst"], {
    encoding: "utf8", env: { PATH: process.env.PATH || "" }
  });
  assert.equal(proc.status, 0, proc.stderr);
  assert.match(proc.stdout, /DRY RUN ONLY/);
});
