import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { recordEventFetch } from "../lib/analytics";

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
  rating_avg: number | null;
  rating_count: number | null;
  google_rating: number | null;
  google_reviews_count: number | null;
  verified_identity: boolean | null;
  verified_card: boolean | null;
};

type Service = { id: string; service: string; variant: string | null; price_cents: number | null };
type Gallery = { id: string; image_url: string; caption: string | null };
type ServiceArea = { id: string; name: string | null };
type Site = {
  headline: string | null;
  description: string | null;
  hero_url: string | null;
  primary_color: string;
  accent_color: string;
  show_services: boolean;
  show_about: boolean;
  show_contact: boolean;
  show_gallery: boolean;
  show_reviews: boolean;
  show_service_areas: boolean;
  is_published: boolean;
};
type Props = { forcedSlug?: string; customDomain?: boolean };

const serviceName = (service: string, variant: string | null) => {
  const name = service.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
  return variant ? `${name} · ${variant}` : name;
};
const price = (pence: number | null) => pence == null ? null : new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(pence / 100);
const websiteUrl = (value: string) => /^https?:\/\//i.test(value) ? value : `https://${value}`;
function upsertMeta(selector: string, attrs: Record<string, string>, content: string) {
  let element = document.head.querySelector<HTMLMetaElement>(selector);
  if (!element) {
    element = document.createElement("meta");
    Object.entries(attrs).forEach(([key, value]) => element?.setAttribute(key, value));
    document.head.appendChild(element);
  }
  element.setAttribute("content", content);
}

export default function PublicCleanerSite({ forcedSlug, customDomain = false }: Props = {}) {
  const params = useParams<{ slug: string }>();
  const slug = forcedSlug || params.slug;
  const [cleaner, setCleaner] = useState<Cleaner | null>(null);
  const [site, setSite] = useState<Site | null>(null);
  const [services, setServices] = useState<Service[]>([]);
  const [gallery, setGallery] = useState<Gallery[]>([]);
  const [areas, setAreas] = useState<ServiceArea[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!slug) { setLoading(false); return; }
      setLoading(true); setError(null);
      const { data: cleanerRow, error: cleanerError } = await supabase
        .from("cleaners")
        .select("id,slug,business_name,logo_url,address,phone,whatsapp,website,about,contact_email,rating_avg,rating_count,google_rating,google_reviews_count,verified_identity,verified_card")
        .eq("slug", slug).eq("is_published", true).eq("is_active", true).maybeSingle();
      if (cancelled) return;
      if (cleanerError) { setError(cleanerError.message); setLoading(false); return; }
      if (!cleanerRow) { setCleaner(null); setSite(null); setLoading(false); return; }
      const cleanerData = cleanerRow as Cleaner;
      setCleaner(cleanerData);

      const { data: siteRow, error: siteError } = await supabase
        .from("cleaner_sites")
        .select("headline,description,hero_url,primary_color,accent_color,show_services,show_about,show_contact,show_gallery,show_reviews,show_service_areas,is_published")
        .eq("cleaner_id", cleanerData.id).eq("is_published", true).maybeSingle();
      if (cancelled) return;
      if (siteError) { setError(siteError.message); setLoading(false); return; }
      if (!siteRow) { setSite(null); setLoading(false); return; }
      const siteData = siteRow as Site;
      setSite(siteData);

      const jobs: PromiseLike<unknown>[] = [];
      if (siteData.show_services) jobs.push(supabase.from("service_offerings").select("id,service,variant,price_cents").eq("cleaner_id", cleanerData.id).eq("is_active", true).order("service").then(({ data, error }) => { if (error) throw error; setServices((data ?? []) as Service[]); }));
      if (siteData.show_gallery) jobs.push(supabase.from("cleaner_gallery").select("id,image_url,caption").eq("cleaner_id", cleanerData.id).order("sort_order").order("created_at").then(({ data, error }) => { if (error) throw error; setGallery((data ?? []) as Gallery[]); }));
      if (siteData.show_service_areas) jobs.push(supabase.from("service_areas").select("id,name").eq("cleaner_id", cleanerData.id).eq("is_published", true).order("name").then(({ data, error }) => { if (error) throw error; setAreas((data ?? []) as ServiceArea[]); }));
      try { await Promise.all(jobs); } catch (e) { if (!cancelled) setError(e instanceof Error ? e.message : "Could not load website."); }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [slug]);

  useEffect(() => {
    if (!cleaner) return;
    recordEventFetch({ cleanerId: cleaner.id, event: "impression", meta: { source: "cleaner_site", custom_domain: customDomain } }).catch(() => undefined);
  }, [cleaner, customDomain]);

  const rating = useMemo(() => {
    if (!cleaner) return null;
    const value = Number(cleaner.google_rating ?? cleaner.rating_avg ?? 0);
    const count = Number(cleaner.google_reviews_count ?? cleaner.rating_count ?? 0);
    return value > 0 && count > 0 ? { value, count } : null;
  }, [cleaner]);

  useEffect(() => {
    if (!cleaner || !site) return;
    const oldTitle = document.title;
    const name = cleaner.business_name || "Local cleaner";
    const description = site.description || cleaner.about || `${name} provides professional local cleaning services.`;
    const canonical = customDomain ? `${window.location.origin}${window.location.pathname || "/"}` : `${window.location.origin}/cleaner/${cleaner.slug}`;
    document.title = `${name} | Local Cleaning Services`;
    upsertMeta('meta[name="description"]', { name: "description" }, description.slice(0, 160));
    upsertMeta('meta[property="og:title"]', { property: "og:title" }, document.title);
    upsertMeta('meta[property="og:description"]', { property: "og:description" }, description.slice(0, 200));
    upsertMeta('meta[property="og:type"]', { property: "og:type" }, "website");
    upsertMeta('meta[property="og:url"]', { property: "og:url" }, canonical);
    if (site.hero_url || cleaner.logo_url) upsertMeta('meta[property="og:image"]', { property: "og:image" }, site.hero_url || cleaner.logo_url || "");
    let canonicalLink = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (!canonicalLink) { canonicalLink = document.createElement("link"); canonicalLink.rel = "canonical"; document.head.appendChild(canonicalLink); }
    canonicalLink.href = canonical;
    const schema = document.createElement("script");
    schema.type = "application/ld+json";
    schema.text = JSON.stringify({
      "@context": "https://schema.org", "@type": "LocalBusiness", name, url: canonical, description,
      telephone: cleaner.phone || cleaner.whatsapp || undefined, email: cleaner.contact_email || undefined,
      image: site.hero_url || cleaner.logo_url || undefined, address: cleaner.address || undefined,
      aggregateRating: rating ? { "@type": "AggregateRating", ratingValue: rating.value, reviewCount: rating.count } : undefined,
      areaServed: areas.map((area) => area.name).filter(Boolean),
      makesOffer: services.map((service) => ({ "@type": "Offer", name: serviceName(service.service, service.variant), priceCurrency: "GBP", price: service.price_cents == null ? undefined : (service.price_cents / 100).toFixed(2) })),
    });
    document.head.appendChild(schema);
    return () => { document.title = oldTitle; schema.remove(); };
  }, [cleaner, site, services, areas, rating, customDomain]);

  if (loading) return <div className="min-h-screen grid place-items-center bg-slate-50">Loading…</div>;
  if (error) return <div className="min-h-screen grid place-items-center bg-slate-50 px-6"><div className="max-w-lg text-center"><h1 className="text-2xl font-bold mb-2">We couldn't load this cleaner</h1><p className="text-slate-600">{error}</p></div></div>;
  if (!cleaner || !site) return <div className="min-h-screen grid place-items-center bg-slate-50 px-6"><div className="max-w-lg text-center"><h1 className="text-3xl font-bold mb-3">Cleaner website unavailable</h1><p className="text-slate-600 mb-6">That business page isn't public right now.</p>{!customDomain && <Link to="/" className="inline-flex rounded-full bg-black px-5 py-3 text-white font-semibold">Back to Klean.ly</Link>}</div></div>;

  const whatsappNumber = cleaner.whatsapp?.replace(/\D/g, "");
  const callNumber = cleaner.phone || cleaner.whatsapp;
  const intro = site.description || cleaner.about || "Professional local cleaning with simple, direct booking and friendly service.";
  const quoteText = encodeURIComponent(`Hi ${cleaner.business_name || "there"}, I'd like to request a quote for cleaning services.`);

  return <div className="min-h-screen bg-slate-50 text-slate-950">
    <header className="bg-white border-b"><div className="mx-auto max-w-6xl px-5 py-5 flex items-center justify-between gap-4"><div className="flex items-center gap-3 min-w-0">{cleaner.logo_url ? <img src={cleaner.logo_url} alt={`${cleaner.business_name ?? "Cleaner"} logo`} className="h-12 w-12 rounded-2xl object-contain border bg-white"/> : <div className="h-12 w-12 rounded-2xl text-white grid place-items-center font-bold text-xl" style={{ backgroundColor: site.primary_color }}>{(cleaner.business_name ?? "K")[0].toUpperCase()}</div>}<div><div className="font-bold">{cleaner.business_name}</div><div className="text-sm text-slate-500">Local cleaning services</div></div></div>{!customDomain && <span className="text-xs sm:text-sm text-slate-500">Powered by Klean.ly</span>}</div></header>
    <main>
      <section className="text-white bg-cover bg-center" style={{ backgroundColor: site.primary_color, backgroundImage: site.hero_url ? `linear-gradient(rgba(0,0,0,.55),rgba(0,0,0,.55)),url(${site.hero_url})` : undefined }}><div className="mx-auto max-w-6xl px-5 py-16 sm:py-24 grid gap-10 lg:grid-cols-[1.3fr_.7fr] lg:items-center"><div><p className="uppercase tracking-[.22em] text-xs font-semibold mb-4" style={{ color: site.accent_color }}>Trusted local cleaner</p><h1 className="text-4xl sm:text-6xl font-black tracking-tight leading-tight">{site.headline || cleaner.business_name}</h1><p className="mt-6 text-lg sm:text-xl text-white/80 max-w-2xl">{intro}</p><div className="mt-6 flex flex-wrap gap-2 text-sm">{rating && <span className="rounded-full bg-white/10 border border-white/15 px-3 py-2">★ {rating.value.toFixed(1)} · {rating.count} reviews</span>}{cleaner.verified_identity && <span className="rounded-full bg-white/10 border border-white/15 px-3 py-2">✓ Identity verified</span>}{cleaner.verified_card && <span className="rounded-full bg-white/10 border border-white/15 px-3 py-2">✓ Payment verified</span>}</div>{site.show_contact && <div className="mt-8 flex flex-wrap gap-3">{whatsappNumber && <a onClick={() => recordEventFetch({ cleanerId: cleaner.id, event: "click_message", meta: { source: "cleaner_site" } }).catch(() => undefined)} href={`https://wa.me/${whatsappNumber}?text=${quoteText}`} className="rounded-full px-6 py-3 font-bold" style={{ backgroundColor: site.accent_color, color: site.primary_color }}>Request a quote</a>}{callNumber && <a onClick={() => recordEventFetch({ cleanerId: cleaner.id, event: "click_phone", meta: { source: "cleaner_site" } }).catch(() => undefined)} href={`tel:${callNumber}`} className="rounded-full border border-white/30 px-6 py-3 font-semibold">Call now</a>}</div>}</div><div className="rounded-3xl bg-white/10 border border-white/10 p-6"><div className="text-sm text-white/70">Serving customers around</div><div className="mt-2 text-2xl font-bold">{areas[0]?.name || cleaner.address || "your local area"}</div>{areas.length > 1 && <div className="mt-2 text-sm text-white/70">+ {areas.length - 1} more published service area{areas.length === 2 ? "" : "s"}</div>}</div></div></section>
      {site.show_reviews && (rating || cleaner.verified_identity || cleaner.verified_card) && <section className="bg-white border-b"><div className="mx-auto max-w-6xl px-5 py-8 grid gap-4 sm:grid-cols-3">{rating && <div className="rounded-2xl border p-5"><div className="text-3xl font-black">★ {rating.value.toFixed(1)}</div><div className="text-sm text-slate-500 mt-1">Based on {rating.count} customer review{rating.count === 1 ? "" : "s"}</div></div>}{cleaner.verified_identity && <div className="rounded-2xl border p-5"><div className="font-bold text-lg">Identity verified</div><div className="text-sm text-slate-500 mt-1">Business identity has been verified by Klean.ly.</div></div>}{cleaner.verified_card && <div className="rounded-2xl border p-5"><div className="font-bold text-lg">Payment method verified</div><div className="text-sm text-slate-500 mt-1">A verified payment method is held on the account.</div></div>}</div></section>}
      {site.show_services && <section className="mx-auto max-w-6xl px-5 py-14 sm:py-20"><p className="text-sm font-semibold uppercase tracking-wider" style={{ color: site.primary_color }}>Services</p><h2 className="text-3xl font-black mt-2 mb-8">What we can help with</h2>{services.length ? <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{services.map((service) => <div key={service.id} className="rounded-3xl bg-white border p-6 shadow-sm"><div className="text-lg font-bold">{serviceName(service.service, service.variant)}</div><div className="mt-4 text-2xl font-black">{price(service.price_cents) || "Ask for price"}</div><div className="mt-2 text-sm text-slate-500">Contact us to arrange your clean.</div></div>)}</div> : <div className="rounded-3xl bg-white border p-7 text-slate-600">Services and pricing will appear here once published.</div>}</section>}
      {site.show_service_areas && areas.length > 0 && <section className="bg-slate-900 text-white"><div className="mx-auto max-w-6xl px-5 py-14 sm:py-20"><p className="text-sm font-semibold uppercase tracking-wider" style={{ color: site.accent_color }}>Coverage</p><h2 className="text-3xl font-black mt-2 mb-7">Areas we serve</h2><div className="flex flex-wrap gap-3">{areas.map((area) => <span key={area.id} className="rounded-full bg-white/10 border border-white/15 px-4 py-2 font-medium">{area.name || "Local area"}</span>)}</div></div></section>}
      {site.show_gallery && gallery.length > 0 && <section className="bg-white border-y"><div className="mx-auto max-w-6xl px-5 py-14 sm:py-20"><p className="text-sm font-semibold uppercase tracking-wider" style={{ color: site.primary_color }}>Our work</p><h2 className="text-3xl font-black mt-2 mb-8">Recent cleaning</h2><div className="grid grid-cols-2 md:grid-cols-3 gap-3 sm:gap-5">{gallery.map((item) => <figure key={item.id} className="overflow-hidden rounded-3xl bg-slate-100 border"><img src={item.image_url} alt={item.caption || `${cleaner.business_name || "Cleaner"} work`} loading="lazy" className="aspect-square h-full w-full object-cover"/>{item.caption && <figcaption className="p-3 text-sm text-slate-600">{item.caption}</figcaption>}</figure>)}</div></div></section>}
      {site.show_about && <section className="bg-white"><div className="mx-auto max-w-6xl px-5 py-14 sm:py-20 grid gap-8 lg:grid-cols-2"><div><p className="text-sm font-semibold uppercase tracking-wider" style={{ color: site.primary_color }}>About</p><h2 className="text-3xl font-black mt-2">A local business you can contact directly</h2><p className="mt-5 text-slate-600 leading-7">{intro}</p></div>{site.show_contact && <div className="rounded-3xl bg-slate-50 border p-7 space-y-4">{cleaner.phone && <a onClick={() => recordEventFetch({ cleanerId: cleaner.id, event: "click_phone", meta: { source: "cleaner_site" } }).catch(() => undefined)} href={`tel:${cleaner.phone}`} className="block"><div className="text-xs uppercase text-slate-500">Phone</div><div className="font-bold mt-1">{cleaner.phone}</div></a>}{cleaner.contact_email && <a href={`mailto:${cleaner.contact_email}`} className="block"><div className="text-xs uppercase text-slate-500">Email</div><div className="font-bold mt-1 break-all">{cleaner.contact_email}</div></a>}{cleaner.website && <a onClick={() => recordEventFetch({ cleanerId: cleaner.id, event: "click_website", meta: { source: "cleaner_site" } }).catch(() => undefined)} href={websiteUrl(cleaner.website)} target="_blank" rel="noreferrer" className="block"><div className="text-xs uppercase text-slate-500">Website</div><div className="font-bold mt-1 break-all">{cleaner.website}</div></a>}</div>}</div></section>}
    </main>
    <footer className="text-white/60" style={{ backgroundColor: site.primary_color }}><div className="mx-auto max-w-6xl px-5 py-8 flex flex-col sm:flex-row gap-2 sm:items-center sm:justify-between text-sm"><div>© {new Date().getFullYear()} {cleaner.business_name}</div>{!customDomain && <Link to="/" className="hover:text-white">Powered by Klean.ly</Link>}</div></footer>
  </div>;
}
