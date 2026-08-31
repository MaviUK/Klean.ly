import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import CleanerBookingModal from "../components/CleanerBookingModal";
import { supabase } from "../lib/supabase";
import { recordEventFetch } from "../lib/analytics";

type Cleaner = {
  id: string; slug: string; business_name: string | null; logo_url: string | null; address: string | null;
  phone: string | null; whatsapp: string | null; website: string | null; about: string | null; contact_email: string | null;
  rating_avg: number | null; rating_count: number | null; google_rating: number | null; google_reviews_count: number | null;
  verified_identity: boolean | null; verified_card: boolean | null;
};
type Service = { id: string; service: string; variant: string | null; price_cents: number | null };
type Gallery = { id: string; image_url: string; caption: string | null };
type ServiceArea = { id: string; name: string | null };
type Site = {
  headline: string | null; description: string | null; hero_url: string | null; primary_color: string; accent_color: string;
  show_services: boolean; show_about: boolean; show_contact: boolean; show_gallery: boolean; show_reviews: boolean;
  show_service_areas: boolean; is_published: boolean;
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
  if (!element) { element = document.createElement("meta"); Object.entries(attrs).forEach(([key, value]) => element?.setAttribute(key, value)); document.head.appendChild(element); }
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
  const [bookingOpen, setBookingOpen] = useState(false);
  const [bookingServiceId, setBookingServiceId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!slug) { setLoading(false); return; }
      setLoading(true); setError(null);
      const { data: cleanerRow, error: cleanerError } = await supabase.from("cleaners")
        .select("id,slug,business_name,logo_url,address,phone,whatsapp,website,about,contact_email,rating_avg,rating_count,google_rating,google_reviews_count,verified_identity,verified_card")
        .eq("slug", slug).eq("is_published", true).eq("is_active", true).maybeSingle();
      if (cancelled) return;
      if (cleanerError) { setError(cleanerError.message); setLoading(false); return; }
      if (!cleanerRow) { setCleaner(null); setSite(null); setLoading(false); return; }
      const cleanerData = cleanerRow as Cleaner; setCleaner(cleanerData);

      const { data: siteRow, error: siteError } = await supabase.from("cleaner_sites")
        .select("headline,description,hero_url,primary_color,accent_color,show_services,show_about,show_contact,show_gallery,show_reviews,show_service_areas,is_published")
        .eq("cleaner_id", cleanerData.id).eq("is_published", true).maybeSingle();
      if (cancelled) return;
      if (siteError) { setError(siteError.message); setLoading(false); return; }
      if (!siteRow) { setSite(null); setLoading(false); return; }
      const siteData = siteRow as Site; setSite(siteData);

      const jobs: PromiseLike<unknown>[] = [
        supabase.from("service_offerings").select("id,service,variant,price_cents").eq("cleaner_id", cleanerData.id).eq("is_active", true).order("service")
          .then(({ data, error }) => { if (error) throw error; setServices((data ?? []) as Service[]); })
      ];
      if (siteData.show_gallery) jobs.push(supabase.from("cleaner_gallery").select("id,image_url,caption").eq("cleaner_id", cleanerData.id).order("sort_order").order("created_at").then(({ data, error }) => { if (error) throw error; setGallery((data ?? []) as Gallery[]); }));
      if (siteData.show_service_areas) jobs.push(supabase.from("service_areas").select("id,name").eq("cleaner_id", cleanerData.id).eq("is_published", true).order("name").then(({ data, error }) => { if (error) throw error; setAreas((data ?? []) as ServiceArea[]); }));
      try { await Promise.all(jobs); } catch (e) { if (!cancelled) setError(e instanceof Error ? e.message : "Could not load website."); }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [slug]);

  useEffect(() => { if (cleaner) recordEventFetch({ cleanerId: cleaner.id, event: "impression", meta: { source: "cleaner_site", custom_domain: customDomain } }).catch(() => undefined); }, [cleaner, customDomain]);
  const rating = useMemo(() => { if (!cleaner) return null; const value = Number(cleaner.google_rating ?? cleaner.rating_avg ?? 0); const count = Number(cleaner.google_reviews_count ?? cleaner.rating_count ?? 0); return value > 0 && count > 0 ? { value, count } : null; }, [cleaner]);

  useEffect(() => {
    if (!cleaner || !site) return;
    const oldTitle = document.title; const name = cleaner.business_name || "Local cleaner";
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
    const schema = document.createElement("script"); schema.type = "application/ld+json";
    schema.text = JSON.stringify({ "@context": "https://schema.org", "@type": "LocalBusiness", name, url: canonical, description,
      telephone: cleaner.phone || cleaner.whatsapp || undefined, email: cleaner.contact_email || undefined, image: site.hero_url || cleaner.logo_url || undefined,
      address: cleaner.address || undefined, aggregateRating: rating ? { "@type": "AggregateRating", ratingValue: rating.value, reviewCount: rating.count } : undefined,
      areaServed: areas.map((area) => area.name).filter(Boolean), makesOffer: services.map((service) => ({ "@type": "Offer", name: serviceName(service.service, service.variant), priceCurrency: "GBP", price: service.price_cents == null ? undefined : (service.price_cents / 100).toFixed(2) })) });
    document.head.appendChild(schema); return () => { document.title = oldTitle; schema.remove(); };
  }, [cleaner, site, services, areas, rating, customDomain]);

  if (loading) return <div className="min-h-screen grid place-items-center bg-slate-50">Loading…</div>;
  if (error) return <div className="min-h-screen grid place-items-center bg-slate-50 px-6"><div className="max-w-lg text-center"><h1 className="text-2xl font-bold mb-2">We couldn't load this cleaner</h1><p className="text-slate-600">{error}</p></div></div>;
  if (!cleaner || !site) return <div className="min-h-screen grid place-items-center bg-slate-50 px-6"><div className="max-w-lg text-center"><h1 className="text-3xl font-bold mb-3">Cleaner website unavailable</h1><p className="text-slate-600 mb-6">That business page isn't public right now.</p>{!customDomain && <Link to="/" className="inline-flex rounded-full bg-black px-5 py-3 text-white font-semibold">Back to Klean.ly</Link>}</div></div>;

  const callNumber = cleaner.phone || cleaner.whatsapp;
  const intro = site.description || cleaner.about || "Professional local cleaning with simple, direct booking and friendly service.";
  const openBooking = (serviceId?: string) => { setBookingServiceId(serviceId || null); setBookingOpen(true); };
  const brandName = cleaner.business_name || "Local Cleaner";
  const initials = brandName.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();

  return <div className="min-h-screen bg-[#f7f8fa] text-slate-950 pb-24 sm:pb-0">
    <header className="sticky top-0 z-40 border-b border-slate-200/80 bg-white/95 backdrop-blur-xl">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3 sm:px-6 lg:px-8">
        <div className="flex min-w-0 items-center gap-3 sm:gap-4">
          {cleaner.logo_url ? <img src={cleaner.logo_url} alt={`${brandName} logo`} className="h-14 w-14 shrink-0 rounded-2xl border border-slate-200 bg-white object-contain p-1.5 shadow-sm sm:h-16 sm:w-16"/> : <div className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl text-lg font-black text-white shadow-sm sm:h-16 sm:w-16" style={{ backgroundColor: site.primary_color }}>{initials || "K"}</div>}
          <div className="min-w-0"><div className="truncate text-lg font-black tracking-tight text-slate-950 sm:text-xl">{brandName}</div><div className="mt-0.5 truncate text-xs font-medium text-slate-500 sm:text-sm">Professional local cleaning</div></div>
        </div>
        <div className="flex items-center gap-2">
          {callNumber && <a onClick={() => recordEventFetch({ cleanerId: cleaner.id, event: "click_phone", meta: { source: "cleaner_site_header" } }).catch(() => undefined)} href={`tel:${callNumber}`} className="hidden rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-bold text-slate-800 shadow-sm hover:bg-slate-50 sm:inline-flex">Call</a>}
          {services.length > 0 && <button type="button" onClick={() => openBooking()} className="rounded-xl px-4 py-2.5 text-sm font-black shadow-sm transition hover:brightness-95" style={{ backgroundColor: site.accent_color, color: site.primary_color }}>Book now</button>}
        </div>
      </div>
    </header>

    <main>
      <section className="relative overflow-hidden" style={{ backgroundColor: site.primary_color }}>
        <div className="absolute inset-0 opacity-[0.06]" style={{ backgroundImage: "radial-gradient(circle at 25px 25px, white 2px, transparent 0)", backgroundSize: "50px 50px" }} />
        <div className="relative mx-auto grid max-w-7xl gap-8 px-4 py-10 sm:px-6 sm:py-14 lg:grid-cols-[1.02fr_.98fr] lg:items-stretch lg:px-8 lg:py-16">
          <div className="flex flex-col justify-center text-white">
            <div className="mb-6 flex items-center gap-4">
              {cleaner.logo_url ? <div className="rounded-3xl bg-white p-3 shadow-2xl shadow-black/20"><img src={cleaner.logo_url} alt={`${brandName} logo`} className="h-24 w-24 object-contain sm:h-28 sm:w-28"/></div> : <div className="grid h-24 w-24 place-items-center rounded-3xl bg-white/10 text-3xl font-black ring-1 ring-white/20 sm:h-28 sm:w-28">{initials || "K"}</div>}
              <div className="min-w-0"><div className="text-xs font-bold uppercase tracking-[.22em] text-white/60">Welcome to</div><div className="mt-1 text-2xl font-black leading-tight sm:text-3xl">{brandName}</div></div>
            </div>
            <h1 className="max-w-3xl text-4xl font-black leading-[1.04] tracking-[-0.04em] sm:text-5xl lg:text-6xl">{site.headline || `Professional cleaning from ${brandName}`}</h1>
            <p className="mt-5 max-w-2xl text-base leading-7 text-white/75 sm:text-lg">{intro}</p>
            <div className="mt-6 flex flex-wrap gap-2 text-sm font-semibold">{rating && <span className="rounded-full border border-white/15 bg-white/10 px-3.5 py-2">★ {rating.value.toFixed(1)} · {rating.count} reviews</span>}{cleaner.verified_identity && <span className="rounded-full border border-white/15 bg-white/10 px-3.5 py-2">✓ Identity verified</span>}{cleaner.verified_card && <span className="rounded-full border border-white/15 bg-white/10 px-3.5 py-2">✓ Payment verified</span>}</div>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:flex-wrap">{services.length > 0 && <button type="button" onClick={() => openBooking()} className="rounded-2xl px-7 py-4 text-base font-black shadow-xl transition hover:-translate-y-0.5" style={{ backgroundColor: site.accent_color, color: site.primary_color }}>Book a clean</button>}{callNumber && <a onClick={() => recordEventFetch({ cleanerId: cleaner.id, event: "click_phone", meta: { source: "cleaner_site_hero" } }).catch(() => undefined)} href={`tel:${callNumber}`} className="rounded-2xl border border-white/25 bg-white/10 px-7 py-4 text-center text-base font-bold text-white backdrop-blur hover:bg-white/15">Call {callNumber}</a>}</div>
          </div>

          <div className="relative min-h-[300px] overflow-hidden rounded-[2rem] border border-white/10 bg-white/10 shadow-2xl shadow-black/20 sm:min-h-[420px]">
            {site.hero_url ? <img src={site.hero_url} alt={`${brandName} cleaning service`} className="absolute inset-0 h-full w-full object-cover"/> : <div className="absolute inset-0 flex flex-col justify-end bg-gradient-to-br from-white/15 to-black/20 p-7 text-white sm:p-9"><div className="text-xs font-bold uppercase tracking-[.2em] text-white/60">Local service</div><div className="mt-2 text-3xl font-black">Clean, reliable, professional.</div></div>}
            <div className="absolute inset-x-4 bottom-4 rounded-2xl border border-white/15 bg-slate-950/65 p-4 text-white backdrop-blur-md sm:inset-x-5 sm:bottom-5 sm:p-5"><div className="text-xs font-bold uppercase tracking-[.16em] text-white/55">Areas covered</div><div className="mt-1 text-lg font-black">{areas[0]?.name || cleaner.address || "Your local area"}</div>{areas.length > 1 && <div className="mt-1 text-sm text-white/65">Plus {areas.length - 1} more service area{areas.length === 2 ? "" : "s"}</div>}</div>
          </div>
        </div>
      </section>

      {site.show_reviews && (rating || cleaner.verified_identity || cleaner.verified_card) && <section className="border-b border-slate-200 bg-white"><div className="mx-auto grid max-w-7xl gap-px bg-slate-200 sm:grid-cols-3">{rating && <div className="bg-white px-6 py-7 text-center sm:py-8"><div className="text-3xl font-black text-slate-950">★ {rating.value.toFixed(1)}</div><div className="mt-1 text-sm font-medium text-slate-500">{rating.count} customer review{rating.count === 1 ? "" : "s"}</div></div>}{cleaner.verified_identity && <div className="bg-white px-6 py-7 text-center sm:py-8"><div className="text-lg font-black text-slate-950">✓ Identity verified</div><div className="mt-1 text-sm text-slate-500">Verified through Klean.ly</div></div>}{cleaner.verified_card && <div className="bg-white px-6 py-7 text-center sm:py-8"><div className="text-lg font-black text-slate-950">✓ Payment verified</div><div className="mt-1 text-sm text-slate-500">Verified payment method held</div></div>}</div></section>}

      {site.show_services && <section className="mx-auto max-w-7xl px-4 py-14 sm:px-6 sm:py-20 lg:px-8"><div className="mb-8 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between"><div><p className="text-xs font-black uppercase tracking-[.2em]" style={{ color: site.primary_color }}>Services & pricing</p><h2 className="mt-2 text-3xl font-black tracking-tight sm:text-4xl">Choose your clean</h2></div><p className="max-w-lg text-sm leading-6 text-slate-500">Select the service you need and send your booking details directly to {brandName}.</p></div>{services.length ? <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">{services.map((service, index) => <article key={service.id} className="group relative overflow-hidden rounded-[1.75rem] border border-slate-200 bg-white p-6 shadow-sm transition hover:-translate-y-1 hover:shadow-xl"><div className="absolute right-5 top-5 grid h-9 w-9 place-items-center rounded-full text-xs font-black" style={{ backgroundColor: `${site.accent_color}22`, color: site.primary_color }}>{String(index + 1).padStart(2, "0")}</div><div className="pr-12 text-lg font-black leading-snug">{serviceName(service.service, service.variant)}</div><div className="mt-5 text-3xl font-black tracking-tight">{price(service.price_cents) || "Price on request"}</div><div className="mt-2 text-sm leading-6 text-slate-500">Book this service online and the cleaner will receive your details instantly.</div><button type="button" onClick={() => openBooking(service.id)} className="mt-6 w-full rounded-2xl px-5 py-3.5 font-black text-white transition group-hover:brightness-110" style={{ backgroundColor: site.primary_color }}>Book this clean</button></article>)}</div> : <div className="rounded-3xl border border-dashed border-slate-300 bg-white p-8 text-center text-slate-500">Services and pricing will appear here once published.</div>}</section>}

      {site.show_gallery && gallery.length > 0 && <section className="border-y border-slate-200 bg-white"><div className="mx-auto max-w-7xl px-4 py-14 sm:px-6 sm:py-20 lg:px-8"><p className="text-xs font-black uppercase tracking-[.2em]" style={{ color: site.primary_color }}>Our work</p><h2 className="mt-2 text-3xl font-black tracking-tight sm:text-4xl">See the results</h2><div className="mt-8 grid grid-cols-2 gap-3 sm:gap-5 md:grid-cols-3">{gallery.map((item) => <figure key={item.id} className="group overflow-hidden rounded-[1.6rem] bg-slate-100"><img src={item.image_url} alt={item.caption || `${brandName} cleaning work`} loading="lazy" className="aspect-square h-full w-full object-cover transition duration-500 group-hover:scale-[1.03]"/>{item.caption && <figcaption className="border-t border-slate-100 bg-white p-3 text-sm font-medium text-slate-600">{item.caption}</figcaption>}</figure>)}</div></div></section>}

      {site.show_service_areas && areas.length > 0 && <section className="text-white" style={{ backgroundColor: site.primary_color }}><div className="mx-auto max-w-7xl px-4 py-14 sm:px-6 sm:py-20 lg:px-8"><div className="grid gap-8 lg:grid-cols-[.7fr_1.3fr] lg:items-start"><div><p className="text-xs font-black uppercase tracking-[.2em]" style={{ color: site.accent_color }}>Coverage</p><h2 className="mt-2 text-3xl font-black tracking-tight sm:text-4xl">Areas we serve</h2><p className="mt-4 max-w-md text-white/65">These are the areas currently published by {brandName}.</p></div><div className="flex flex-wrap gap-3">{areas.map((area) => <span key={area.id} className="rounded-2xl border border-white/15 bg-white/10 px-4 py-3 font-bold backdrop-blur">{area.name || "Local area"}</span>)}</div></div></div></section>}

      {site.show_about && <section className="bg-white"><div className="mx-auto grid max-w-7xl gap-8 px-4 py-14 sm:px-6 sm:py-20 lg:grid-cols-[1.2fr_.8fr] lg:px-8"><div><p className="text-xs font-black uppercase tracking-[.2em]" style={{ color: site.primary_color }}>About {brandName}</p><h2 className="mt-2 max-w-2xl text-3xl font-black tracking-tight sm:text-4xl">A local cleaning business you can book directly.</h2><p className="mt-5 max-w-2xl text-base leading-7 text-slate-600">{intro}</p></div>{site.show_contact && <aside className="rounded-[1.75rem] border border-slate-200 bg-[#f8fafc] p-6 sm:p-7"><div className="flex items-center gap-4">{cleaner.logo_url ? <img src={cleaner.logo_url} alt="" className="h-14 w-14 rounded-2xl border bg-white object-contain p-1"/> : <div className="grid h-14 w-14 place-items-center rounded-2xl text-lg font-black text-white" style={{ backgroundColor: site.primary_color }}>{initials}</div>}<div><div className="font-black">{brandName}</div><div className="text-sm text-slate-500">Get in touch</div></div></div>{services.length > 0 && <button type="button" onClick={() => openBooking()} className="mt-6 w-full rounded-2xl px-5 py-3.5 font-black" style={{ backgroundColor: site.accent_color, color: site.primary_color }}>Book a clean</button>}<div className="mt-5 divide-y divide-slate-200">{cleaner.phone && <a onClick={() => recordEventFetch({ cleanerId: cleaner.id, event: "click_phone", meta: { source: "cleaner_site_contact" } }).catch(() => undefined)} href={`tel:${cleaner.phone}`} className="block py-4"><div className="text-xs font-bold uppercase tracking-wider text-slate-400">Phone</div><div className="mt-1 font-bold text-slate-900">{cleaner.phone}</div></a>}{cleaner.contact_email && <a href={`mailto:${cleaner.contact_email}`} className="block py-4"><div className="text-xs font-bold uppercase tracking-wider text-slate-400">Email</div><div className="mt-1 break-all font-bold text-slate-900">{cleaner.contact_email}</div></a>}{cleaner.website && <a onClick={() => recordEventFetch({ cleanerId: cleaner.id, event: "click_website", meta: { source: "cleaner_site_contact" } }).catch(() => undefined)} href={websiteUrl(cleaner.website)} target="_blank" rel="noreferrer" className="block py-4"><div className="text-xs font-bold uppercase tracking-wider text-slate-400">Website</div><div className="mt-1 break-all font-bold text-slate-900">{cleaner.website}</div></a>}</div></aside>}</div></section>}
    </main>

    <footer className="border-t border-white/10 text-white" style={{ backgroundColor: site.primary_color }}><div className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-8 sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8"><div className="flex items-center gap-3">{cleaner.logo_url && <div className="rounded-xl bg-white p-1.5"><img src={cleaner.logo_url} alt="" className="h-8 w-8 object-contain"/></div>}<div><div className="font-black">{brandName}</div><div className="text-xs text-white/50">© {new Date().getFullYear()} All rights reserved.</div></div></div>{!customDomain && <Link to="/" className="text-xs font-semibold text-white/50 hover:text-white">Website powered by Klean.ly</Link>}</div></footer>

    {services.length > 0 && <div className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-200 bg-white/95 p-3 shadow-[0_-12px_30px_rgba(15,23,42,.12)] backdrop-blur sm:hidden"><button type="button" onClick={() => openBooking()} className="w-full rounded-2xl px-5 py-4 text-base font-black" style={{ backgroundColor: site.accent_color, color: site.primary_color }}>Book a clean with {brandName}</button></div>}

    <CleanerBookingModal open={bookingOpen} onClose={() => setBookingOpen(false)} cleanerId={cleaner.id} businessName={brandName} services={services} primaryColor={site.primary_color} accentColor={site.accent_color} initialServiceId={bookingServiceId} />
  </div>;
}
