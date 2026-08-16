import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabase";

type Cleaner = {
  id: string;
  business_name: string | null;
  slug: string;
  logo_url: string | null;
  is_published: boolean | null;
};

type Site = {
  headline: string | null;
  description: string | null;
  hero_url: string | null;
  primary_color: string;
  accent_color: string;
  show_services: boolean;
  show_about: boolean;
  show_contact: boolean;
  is_published: boolean;
};

type Domain = {
  id: string;
  domain: string;
  verification_token: string;
  verified: boolean;
  primary_domain: boolean;
  verified_at: string | null;
};

const NETLIFY_CNAME_TARGET = "main--findabincleaner.netlify.app";

const defaults: Site = {
  headline: "",
  description: "",
  hero_url: "",
  primary_color: "#0f172a",
  accent_color: "#34d399",
  show_services: true,
  show_about: true,
  show_contact: true,
  is_published: true,
};

function cleanDomain(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/\.$/, "");
}

function verificationHost(domain: string) {
  return `_kleanly-verify.${domain}`;
}

export default function Website() {
  const [cleaner, setCleaner] = useState<Cleaner | null>(null);
  const [site, setSite] = useState<Site>(defaults);
  const [domains, setDomains] = useState<Domain[]>([]);
  const [domainInput, setDomainInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [domainBusy, setDomainBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const publicPath = useMemo(() => cleaner ? `/cleaner/${cleaner.slug}` : "", [cleaner]);

  async function loadDomains(cleanerId: string) {
    const { data, error } = await supabase
      .from("cleaner_domains")
      .select("id,domain,verification_token,verified,primary_domain,verified_at")
      .eq("cleaner_id", cleanerId)
      .order("created_at");
    if (error) throw error;
    setDomains((data || []) as Domain[]);
  }

  useEffect(() => {
    (async () => {
      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return;

        const { data: c, error: cleanerError } = await supabase
          .from("cleaners")
          .select("id,business_name,slug,logo_url,is_published")
          .eq("user_id", user.id)
          .single();
        if (cleanerError) throw cleanerError;

        setCleaner(c as Cleaner);

        const [{ data: s, error: siteError }] = await Promise.all([
          supabase
            .from("cleaner_sites")
            .select("headline,description,hero_url,primary_color,accent_color,show_services,show_about,show_contact,is_published")
            .eq("cleaner_id", c.id)
            .maybeSingle(),
          loadDomains(c.id),
        ]);

        if (siteError) throw siteError;
        if (s) setSite({ ...defaults, ...(s as Site) });
      } catch (error: any) {
        setMessage(error?.message || "Could not load website settings.");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function save() {
    if (!cleaner || saving) return;
    setSaving(true);
    setMessage(null);
    try {
      const payload = {
        cleaner_id: cleaner.id,
        ...site,
        headline: site.headline?.trim() || null,
        description: site.description?.trim() || null,
        hero_url: site.hero_url?.trim() || null,
        updated_at: new Date().toISOString(),
      };
      const { error } = await supabase
        .from("cleaner_sites")
        .upsert(payload, { onConflict: "cleaner_id" });
      if (error) throw error;
      setMessage("Website settings saved.");
    } catch (error: any) {
      setMessage(error?.message || "Could not save website settings.");
    } finally {
      setSaving(false);
    }
  }

  async function addDomain() {
    if (!cleaner) return;
    const domain = cleanDomain(domainInput);
    if (!domain || !domain.includes(".")) {
      setMessage("Enter a valid hostname, for example www.mycleaningcompany.co.uk.");
      return;
    }
    if (domain === "klean.ly" || domain.endsWith(".klean.ly") || domain.endsWith(".netlify.app")) {
      setMessage("Please use a domain your business owns, not a Klean.ly or Netlify hostname.");
      return;
    }

    setDomainBusy("add");
    setMessage(null);
    try {
      const { error } = await supabase
        .from("cleaner_domains")
        .insert({ cleaner_id: cleaner.id, domain });
      if (error) throw error;
      setDomainInput("");
      await loadDomains(cleaner.id);
      setMessage("Domain added. Add both DNS records below, then click Verify DNS.");
    } catch (error: any) {
      setMessage(error?.code === "23505" ? "That domain is already connected to an account." : error?.message || "Could not add domain.");
    } finally {
      setDomainBusy(null);
    }
  }

  async function verifyDomain(domain: Domain) {
    if (!cleaner) return;
    setDomainBusy(domain.id);
    setMessage(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) throw new Error("Please sign in again before verifying the domain.");

      const response = await fetch("/.netlify/functions/verify-cleaner-domain", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ domainId: domain.id }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result?.error || "Domain verification failed.");

      await loadDomains(cleaner.id);
      if (result.ownershipVerified && result.trafficReady) {
        setMessage("Domain ownership and CNAME are verified. The final step is attaching this hostname to the Klean.ly Netlify project for SSL.");
      } else if (result.ownershipVerified) {
        setMessage(`Ownership verified. The CNAME for ${domain.domain} still needs to point to ${NETLIFY_CNAME_TARGET}.`);
      } else {
        setMessage(`Verification TXT record not found yet at ${verificationHost(domain.domain)}. DNS changes can take a little time to appear.`);
      }
    } catch (error: any) {
      setMessage(error?.message || "Could not verify domain.");
    } finally {
      setDomainBusy(null);
    }
  }

  async function removeDomain(id: string) {
    if (!cleaner) return;
    setDomainBusy(id);
    setMessage(null);
    try {
      const { error } = await supabase
        .from("cleaner_domains")
        .delete()
        .eq("id", id)
        .eq("cleaner_id", cleaner.id);
      if (error) throw error;
      await loadDomains(cleaner.id);
    } catch (error: any) {
      setMessage(error?.message || "Could not remove domain.");
    } finally {
      setDomainBusy(null);
    }
  }

  if (loading) {
    return <main className="container mx-auto max-w-6xl px-4 sm:px-6 py-8">Loading website settings…</main>;
  }
  if (!cleaner) {
    return <main className="container mx-auto max-w-6xl px-4 sm:px-6 py-8">No cleaner profile found.</main>;
  }

  const live = !!cleaner.is_published && site.is_published;

  return (
    <main className="container mx-auto max-w-6xl px-4 sm:px-6 py-8 space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <Link to="/dashboard" className="text-sm underline">← Dashboard</Link>
          <h1 className="text-2xl font-bold mt-2">Your Website</h1>
          <p className="muted mt-1">Manage the public website customers see.</p>
        </div>
        <div className="flex gap-2">
          <a href={publicPath} target="_blank" rel="noreferrer" className="btn">Open website ↗</a>
          <button onClick={save} disabled={saving} className="btn btn-primary">{saving ? "Saving…" : "Save changes"}</button>
        </div>
      </div>

      {message && <div className="rounded-xl border bg-white px-4 py-3 text-sm">{message}</div>}

      <section className="card">
        <div className="card-pad space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="font-semibold">Klean.ly website address</h2>
              <p className="muted text-sm">This permanent address always works while your site is published.</p>
            </div>
            <span className={`rounded-full px-3 py-1 text-xs font-semibold ${live ? "bg-green-100 text-green-800" : "bg-gray-100 text-gray-600"}`}>{live ? "Live" : "Not public"}</span>
          </div>
          <div className="rounded-xl bg-gray-50 border px-4 py-3 font-mono text-sm break-all">{window.location.origin}{publicPath}</div>
        </div>
      </section>

      <section className="card">
        <div className="card-pad space-y-4">
          <div>
            <h2 className="text-lg font-semibold">Custom domain</h2>
            <p className="muted text-sm">Connect a hostname you own, such as www.mycleaningcompany.co.uk.</p>
          </div>

          <div className="flex flex-col sm:flex-row gap-2">
            <input
              value={domainInput}
              onChange={(event) => setDomainInput(event.target.value)}
              placeholder="www.mycleaningcompany.co.uk"
              className="flex-1 rounded-xl border px-3 py-2"
            />
            <button type="button" onClick={addDomain} disabled={domainBusy === "add"} className="btn btn-primary">
              {domainBusy === "add" ? "Adding…" : "Add domain"}
            </button>
          </div>

          {domains.length === 0 ? (
            <div className="rounded-xl border border-dashed p-4 text-sm text-gray-600">No custom domain connected yet.</div>
          ) : (
            <div className="space-y-3">
              {domains.map((domain) => (
                <div key={domain.id} className="rounded-xl border p-4 space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="font-semibold">{domain.domain}</div>
                      <div className={`text-xs mt-1 ${domain.verified ? "text-green-700" : "text-amber-700"}`}>
                        {domain.verified ? "Ownership verified" : "Waiting for DNS verification"}
                      </div>
                    </div>
                    <button disabled={domainBusy === domain.id} onClick={() => removeDomain(domain.id)} className="text-xs underline text-red-700">Remove</button>
                  </div>

                  <div className="rounded-lg bg-gray-50 p-3 text-sm space-y-3">
                    <div>
                      <div className="font-semibold">1. Point the hostname to Klean.ly</div>
                      <div className="mt-1">Create a <b>CNAME</b> record for <code>{domain.domain}</code> pointing to:</div>
                      <div className="font-mono text-xs break-all rounded bg-white border p-2 mt-2">{NETLIFY_CNAME_TARGET}</div>
                    </div>
                    <div>
                      <div className="font-semibold">2. Prove ownership</div>
                      <div className="mt-1">Create a <b>TXT</b> record at:</div>
                      <div className="font-mono text-xs break-all rounded bg-white border p-2 mt-2">{verificationHost(domain.domain)}</div>
                      <div className="mt-2">with this value:</div>
                      <div className="font-mono text-xs break-all rounded bg-white border p-2 mt-2">{domain.verification_token}</div>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2 items-center">
                    <button type="button" onClick={() => verifyDomain(domain)} disabled={domainBusy === domain.id} className="btn">
                      {domainBusy === domain.id ? "Checking…" : domain.verified ? "Check DNS again" : "Verify DNS"}
                    </button>
                    {domain.verified && <a href={`https://${domain.domain}`} target="_blank" rel="noreferrer" className="text-sm underline">Open custom domain ↗</a>}
                  </div>

                  <p className="text-xs text-gray-500">After DNS is verified, Klean.ly must attach this hostname to the Netlify project so Netlify can issue the HTTPS certificate.</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      <div className="grid lg:grid-cols-[1fr_0.9fr] gap-6">
        <section className="card">
          <div className="card-pad space-y-5">
            <div>
              <h2 className="text-lg font-semibold">Content & appearance</h2>
              <p className="muted text-sm">Changes appear on your public page after saving.</p>
            </div>
            <label className="block">
              <span className="text-sm font-medium">Headline</span>
              <input value={site.headline || ""} onChange={(event) => setSite({ ...site, headline: event.target.value })} className="mt-1 w-full rounded-xl border px-3 py-2" placeholder={`Professional local cleaning from ${cleaner.business_name || "your business"}`} />
            </label>
            <label className="block">
              <span className="text-sm font-medium">Introduction</span>
              <textarea rows={5} value={site.description || ""} onChange={(event) => setSite({ ...site, description: event.target.value })} className="mt-1 w-full rounded-xl border px-3 py-2" placeholder="Tell customers what makes your business different." />
            </label>
            <label className="block">
              <span className="text-sm font-medium">Hero image URL</span>
              <input value={site.hero_url || ""} onChange={(event) => setSite({ ...site, hero_url: event.target.value })} className="mt-1 w-full rounded-xl border px-3 py-2" placeholder="https://…" />
            </label>
            <div className="grid sm:grid-cols-2 gap-4">
              <label>
                <span className="text-sm font-medium">Main colour</span>
                <div className="mt-1 flex gap-2"><input type="color" value={site.primary_color} onChange={(event) => setSite({ ...site, primary_color: event.target.value })} className="h-10 w-12" /><input value={site.primary_color} onChange={(event) => setSite({ ...site, primary_color: event.target.value })} className="w-full rounded-xl border px-3 py-2" /></div>
              </label>
              <label>
                <span className="text-sm font-medium">Accent colour</span>
                <div className="mt-1 flex gap-2"><input type="color" value={site.accent_color} onChange={(event) => setSite({ ...site, accent_color: event.target.value })} className="h-10 w-12" /><input value={site.accent_color} onChange={(event) => setSite({ ...site, accent_color: event.target.value })} className="w-full rounded-xl border px-3 py-2" /></div>
              </label>
            </div>
            <div className="space-y-3">
              <h3 className="font-semibold">Sections</h3>
              {([['show_services', 'Show services & prices'], ['show_about', 'Show about section'], ['show_contact', 'Show contact buttons']] as const).map(([key, label]) => (
                <label key={key} className="flex items-center justify-between rounded-xl border px-4 py-3"><span className="text-sm font-medium">{label}</span><input type="checkbox" checked={site[key]} onChange={(event) => setSite({ ...site, [key]: event.target.checked })} className="h-5 w-5" /></label>
              ))}
            </div>
            <label className="flex items-center justify-between rounded-xl border px-4 py-3"><div><div className="text-sm font-semibold">Publish website</div><div className="muted text-xs">Turn this off to hide the website.</div></div><input type="checkbox" checked={site.is_published} onChange={(event) => setSite({ ...site, is_published: event.target.checked })} className="h-5 w-5" /></label>
          </div>
        </section>

        <section className="card overflow-hidden">
          <div className="card-pad">
            <h2 className="text-lg font-semibold">Quick preview</h2>
            <p className="muted text-sm mb-4">Preview your colours and headline.</p>
            <div className="overflow-hidden rounded-2xl border bg-white">
              <div className="p-6 text-white" style={{ background: site.primary_color }}>
                {cleaner.logo_url && <img src={cleaner.logo_url} alt="Business logo" className="h-14 w-14 object-contain rounded-xl bg-white p-1 mb-5" />}
                <div className="text-xs font-bold uppercase tracking-widest mb-2" style={{ color: site.accent_color }}>{cleaner.business_name}</div>
                <div className="text-2xl font-black">{site.headline || `Professional local cleaning from ${cleaner.business_name || "us"}`}</div>
                <p className="mt-3 text-sm text-white/80">{site.description || "Your introduction will appear here."}</p>
                <div className="mt-5 inline-flex rounded-xl px-4 py-2 text-sm font-bold" style={{ background: site.accent_color, color: site.primary_color }}>Get in touch</div>
              </div>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
