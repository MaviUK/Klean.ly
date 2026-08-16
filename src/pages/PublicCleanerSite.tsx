import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { supabase } from "../lib/supabase";

type Cleaner = {
  id: string;
  slug: string;
  business_name: string | null;
  logo_url: string | null;
  address: string | null;
  phone: string | null;
  whatsapp: string | null;
  website: string | null;
  about: string | null;
  contact_email: string | null;
};

type ServiceOffering = {
  id: string;
  service: string;
  variant: string | null;
  price_cents: number | null;
};

type CleanerSite = {
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

function formatServiceName(service: string, variant: string | null) {
  const serviceName = service
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
  return variant ? `${serviceName} · ${variant}` : serviceName;
}

function formatPrice(priceCents: number | null) {
  if (priceCents == null) return null;
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
  }).format(priceCents / 100);
}

function normaliseWebsite(value: string) {
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

export default function PublicCleanerSite() {
  const { slug } = useParams<{ slug: string }>();
  const [cleaner, setCleaner] = useState<Cleaner | null>(null);
  const [site, setSite] = useState<CleanerSite | null>(null);
  const [services, setServices] = useState<ServiceOffering[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (!slug) {
        setLoading(false);
        return;
      }

      setLoading(true);
      setError(null);

      const { data: cleanerRow, error: cleanerError } = await supabase
        .from("cleaners")
        .select(
          "id, slug, business_name, logo_url, address, phone, whatsapp, website, about, contact_email"
        )
        .eq("slug", slug)
        .eq("is_published", true)
        .eq("is_active", true)
        .maybeSingle();

      if (cancelled) return;
      if (cleanerError) {
        setError(cleanerError.message);
        setLoading(false);
        return;
      }

      if (!cleanerRow) {
        setCleaner(null);
        setSite(null);
        setLoading(false);
        return;
      }

      const cleanerData = cleanerRow as Cleaner;
      setCleaner(cleanerData);

      const { data: siteRow, error: siteError } = await supabase
        .from("cleaner_sites")
        .select(
          "headline, description, hero_url, primary_color, accent_color, show_services, show_about, show_contact, is_published"
        )
        .eq("cleaner_id", cleanerData.id)
        .eq("is_published", true)
        .maybeSingle();

      if (cancelled) return;
      if (siteError) {
        setError(siteError.message);
        setLoading(false);
        return;
      }

      // Fail closed: no publicly visible cleaner_sites row means no public website.
      if (!siteRow) {
        setSite(null);
        setLoading(false);
        return;
      }

      setSite(siteRow as CleanerSite);

      if ((siteRow as CleanerSite).show_services) {
        const { data: offerings, error: servicesError } = await supabase
          .from("service_offerings")
          .select("id, service, variant, price_cents")
          .eq("cleaner_id", cleanerData.id)
          .eq("is_active", true)
          .order("service")
          .order("variant");

        if (cancelled) return;
        if (servicesError) {
          setError(servicesError.message);
          setLoading(false);
          return;
        }

        setServices((offerings ?? []) as ServiceOffering[]);
      } else {
        setServices([]);
      }

      setLoading(false);
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  if (loading) {
    return <div className="min-h-screen grid place-items-center bg-slate-50">Loading…</div>;
  }

  if (error) {
    return (
      <div className="min-h-screen grid place-items-center bg-slate-50 px-6">
        <div className="max-w-lg text-center">
          <h1 className="text-2xl font-bold mb-2">We couldn't load this cleaner</h1>
          <p className="text-slate-600">{error}</p>
        </div>
      </div>
    );
  }

  if (!cleaner || !site) {
    return (
      <div className="min-h-screen grid place-items-center bg-slate-50 px-6">
        <div className="max-w-lg text-center">
          <h1 className="text-3xl font-bold mb-3">Cleaner website unavailable</h1>
          <p className="text-slate-600 mb-6">That business page isn't public right now.</p>
          <Link
            to="/"
            className="inline-flex rounded-full bg-black px-5 py-3 text-white font-semibold"
          >
            Back to Klean.ly
          </Link>
        </div>
      </div>
    );
  }

  const whatsappNumber = cleaner.whatsapp?.replace(/\D/g, "");
  const callNumber = cleaner.phone || cleaner.whatsapp;
  const intro =
    site.description ||
    cleaner.about ||
    "Professional local cleaning with simple, direct booking and friendly service.";

  return (
    <div className="min-h-screen bg-slate-50 text-slate-950">
      <header className="bg-white border-b border-slate-200">
        <div className="mx-auto max-w-6xl px-5 py-5 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            {cleaner.logo_url ? (
              <img
                src={cleaner.logo_url}
                alt={`${cleaner.business_name ?? "Cleaner"} logo`}
                className="h-12 w-12 rounded-2xl object-contain border border-slate-200 bg-white"
              />
            ) : (
              <div
                className="h-12 w-12 rounded-2xl text-white grid place-items-center font-bold text-xl"
                style={{ backgroundColor: site.primary_color }}
              >
                {(cleaner.business_name ?? "K").slice(0, 1).toUpperCase()}
              </div>
            )}
            <div className="min-w-0">
              <div className="font-bold truncate">{cleaner.business_name}</div>
              <div className="text-sm text-slate-500 truncate">Local cleaning services</div>
            </div>
          </div>
          <span className="text-xs sm:text-sm text-slate-500">Powered by Klean.ly</span>
        </div>
      </header>

      <main>
        <section
          className="text-white bg-cover bg-center"
          style={{
            backgroundColor: site.primary_color,
            backgroundImage: site.hero_url
              ? `linear-gradient(rgba(0,0,0,.55), rgba(0,0,0,.55)), url(${site.hero_url})`
              : undefined,
          }}
        >
          <div className="mx-auto max-w-6xl px-5 py-16 sm:py-24 grid gap-10 lg:grid-cols-[1.3fr_.7fr] lg:items-center">
            <div>
              <p
                className="uppercase tracking-[0.22em] text-xs font-semibold mb-4"
                style={{ color: site.accent_color }}
              >
                Trusted local cleaner
              </p>
              <h1 className="text-4xl sm:text-6xl font-black tracking-tight leading-tight">
                {site.headline || cleaner.business_name}
              </h1>
              <p className="mt-6 text-lg sm:text-xl text-white/80 max-w-2xl">{intro}</p>

              {site.show_contact && (
                <div className="mt-8 flex flex-wrap gap-3">
                  {whatsappNumber && (
                    <a
                      href={`https://wa.me/${whatsappNumber}`}
                      className="rounded-full px-6 py-3 font-bold"
                      style={{
                        backgroundColor: site.accent_color,
                        color: site.primary_color,
                      }}
                    >
                      Book on WhatsApp
                    </a>
                  )}
                  {callNumber && (
                    <a
                      href={`tel:${callNumber}`}
                      className="rounded-full border border-white/30 px-6 py-3 font-semibold hover:bg-white/10"
                    >
                      Call now
                    </a>
                  )}
                </div>
              )}
            </div>

            <div className="rounded-3xl bg-white/10 border border-white/10 p-6 backdrop-blur">
              <div className="text-sm text-white/70">Serving customers around</div>
              <div className="mt-2 text-2xl font-bold">{cleaner.address || "your local area"}</div>
            </div>
          </div>
        </section>

        {site.show_services && (
          <section className="mx-auto max-w-6xl px-5 py-14 sm:py-20">
            <div className="mb-8">
              <p
                className="text-sm font-semibold uppercase tracking-wider"
                style={{ color: site.primary_color }}
              >
                Services
              </p>
              <h2 className="text-3xl font-black mt-2">What we can help with</h2>
            </div>

            {services.length ? (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {services.map((service) => {
                  const servicePrice = formatPrice(service.price_cents);
                  return (
                    <div
                      key={service.id}
                      className="rounded-3xl bg-white border border-slate-200 p-6 shadow-sm"
                    >
                      <div className="text-lg font-bold">
                        {formatServiceName(service.service, service.variant)}
                      </div>
                      <div className="mt-4 text-2xl font-black">
                        {servicePrice || "Ask for price"}
                      </div>
                      <div className="mt-2 text-sm text-slate-500">
                        Contact us to arrange your clean.
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="rounded-3xl bg-white border border-slate-200 p-7 text-slate-600">
                Services and pricing will appear here once published.
              </div>
            )}
          </section>
        )}

        {site.show_about && (
          <section className="bg-white border-y border-slate-200">
            <div className="mx-auto max-w-6xl px-5 py-14 sm:py-20 grid gap-8 lg:grid-cols-2">
              <div>
                <p
                  className="text-sm font-semibold uppercase tracking-wider"
                  style={{ color: site.primary_color }}
                >
                  About
                </p>
                <h2 className="text-3xl font-black mt-2">
                  A local business you can contact directly
                </h2>
                <p className="mt-5 text-slate-600 leading-7">{intro}</p>
              </div>

              {site.show_contact && (
                <div className="rounded-3xl bg-slate-50 border border-slate-200 p-7 space-y-4">
                  {cleaner.phone && (
                    <a href={`tel:${cleaner.phone}`} className="block">
                      <div className="text-xs uppercase tracking-wider text-slate-500">Phone</div>
                      <div className="font-bold mt-1">{cleaner.phone}</div>
                    </a>
                  )}
                  {cleaner.contact_email && (
                    <a href={`mailto:${cleaner.contact_email}`} className="block">
                      <div className="text-xs uppercase tracking-wider text-slate-500">Email</div>
                      <div className="font-bold mt-1 break-all">{cleaner.contact_email}</div>
                    </a>
                  )}
                  {cleaner.website && (
                    <a
                      href={normaliseWebsite(cleaner.website)}
                      target="_blank"
                      rel="noreferrer"
                      className="block"
                    >
                      <div className="text-xs uppercase tracking-wider text-slate-500">Website</div>
                      <div className="font-bold mt-1 break-all">{cleaner.website}</div>
                    </a>
                  )}
                </div>
              )}
            </div>
          </section>
        )}
      </main>

      <footer className="text-white/60" style={{ backgroundColor: site.primary_color }}>
        <div className="mx-auto max-w-6xl px-5 py-8 flex flex-col sm:flex-row gap-2 sm:items-center sm:justify-between text-sm">
          <div>© {new Date().getFullYear()} {cleaner.business_name}</div>
          <Link to="/" className="hover:text-white">Powered by Klean.ly</Link>
        </div>
      </footer>
    </div>
  );
}
