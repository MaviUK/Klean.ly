import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import CleanerBookingForm from "../components/CleanerBookingForm";
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
  const businessName = cleaner.business_name || "Your cleaner";
  const goToBooking = (serviceId?: string) => {
    setBookingServiceId(serviceId || null);
    window.requestAnimationFrame(() => document.getElementById("book-a-clean")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };

  return <div className="min-h-screen bg-[#f7f8fa] text-slate-950 pb-20 sm:pb-0">
    <header className="sticky top-0 z-30 border-b border-slate-200/80 bg-white/95 backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
        <div className="flex min-w-0 items-center gap-4">
          {cleaner.logo_url ? <img src={cleaner.logo_url} alt={`${businessName} logo`} className="h-16 w-16 shrink-0 rounded-2xl border border-slate-200 bg-white object-contain p-1 shadow-sm sm:h-20 sm:w-20"/> : <div className="grid h-16 w-16 shrink-0 place-items-center rounded-2xl text-2xl font-black text-white sm:h-20 sm:w-20" style={{ backgroundColor: site.primary_color }}>{businessName[0].toUpperCase()}</div>}
          <div className="min-w-0"><div className="truncate text-xl font-black tracking-tight sm:text-2xl">{businessName}</div><div className="mt-1 text-sm text-slate-500">Professional local cleaning</div></div>
        </div>
        <div className="hidden items-center gap-3 sm:flex">
          {callNumber && <a href={`tel:${callNumber}`} onClick={() => recordEventFetch({ cleanerId: cleaner.id, event: "click_phone", meta: { source: "cleaner_site_header" } }).catch(() => undefined)} className="rounded-full border border-slate-300 bg-white px-5 py-2.5 text-sm font-bold">Call</a>}
          <button type="button" disabled={!services.length} onClick={() => goToBooking()} className="rounded-full px-5 py-2.5 text-sm font-black disabled:opacity-50" style={{ backgroundColor: site.accent_color, color: site.primary_color }}>Book a clean</button>
        </div>
      </div>
    </header>

    <main>
      <section className="relative overflow-hidden text-white" style={{ backgroundColor: site.primary_color }}>
        {site.hero_url && <img src={site.hero_url} alt="" className="absolute inset-0 h-full w-full object-cover opacity-30" />}
        <div className="absolute inset-0 bg-gradient-to-r from-black/65 via-black/45 to-black/20" />
        <div className="relative mx-auto grid max-w-7xl gap-10 px-4 py-14 sm:px-6 sm:py-20 lg:grid-cols-[1fr_.8fr] lg:items-center lg:py-24">
          <div>
            <div className="mb-6 flex items-center gap-4">
              {cleaner.logo_url && <div className="rounded-3xl bg-white p-3 shadow-2xl"><img src={cleaner.logo_url} alt={`${businessName} logo`} className="h-20 w-20 object-contain sm:h-28 sm:w-28" /></div>}
              <div><p className="text-xs font-black uppercase tracking-[.22em]" style={{ color: site.accent_color }}>{businessName}</p><div className="mt-2 text-sm font-semibold text-white/70">Local • Trusted • Easy online booking</div></div>
            </div>
            <h1 className="max-w-4xl text-4xl font-black leading-[1.03] tracking-tight sm:text-6xl lg:text-7xl">{site.headline || `Professional cleaning from ${businessName}`}</h1>
            <p className="mt-6 max-w-2xl text-lg leading-8 text-white/80 sm:text-xl">{intro}</p>
            <div className="mt-7 flex flex-wrap gap-2 text-sm font-semibold">{rating && <span className="rounded-full border border-white/20 bg-white/10 px-4 py-2.5">★ {rating.value.toFixed(1)} · {rating.count} reviews</span>}{cleaner.verified_identity && <span className="rounded-full border border-white/20 bg-white/10 px-4 py-2.5">✓ Identity verified</span>}{cleaner.verified_card && <span className="rounded-full border border-white/20 bg-white/10 px-4 py-2.5">✓ Payment verified</span>}</div>
            <div className="mt-9 flex flex-wrap gap-3"><button type="button" disabled={!services.length} onClick={() => goToBooking()} className="rounded-full px-7 py-4 text-base font-black shadow-lg disabled:opacity-50" style={{ backgroundColor: site.accent_color, color: site.primary_color }}>{services.length ? "Book a clean" : "Booking unavailable"}</button>{callNumber && <a href={`tel:${callNumber}`} onClick={() => recordEventFetch({ cleanerId: cleaner.id, event: "click_phone", meta: { source: "cleaner_site_hero" } }).catch(() => undefined)} className="rounded-full border border-white/30 bg-white/10 px-7 py-4 text-base font-bold">Call {businessName}</a>}</div>
          </div>
          <div className="rounded-[2rem] border border-white/15 bg-white/10 p-6 shadow-2xl backdrop-blur-sm sm:p-8"><div className="text-xs font-bold uppercase tracking-[.18em] text-white/60">Areas we cover</div><div className="mt-3 text-3xl font-black">{areas[0]?.name || cleaner.address || "Your local area"}</div>{areas.length > 1 && <div className="mt-3 text-white/70">Plus {areas.slice(1, 4).map((area) => area.name).filter(Boolean).join(", ")}{areas.length > 4 ? ` and ${areas.length - 4} more` : ""}</div>}<div className="mt-7 border-t border-white/15 pt-6"><div className="text-sm text-white/70">Book directly with</div><div className="mt-1 text-xl font-black">{businessName}</div></div></div>
        </div>
      </section>

      {site.show_reviews && (rating || cleaner.verified_identity || cleaner.verified_card) && <section className="border-b border-slate-200 bg-white"><div className="mx-auto grid max-w-7xl gap-px bg-slate-200 sm:grid-cols-3">{rating && <div className="bg-white px-6 py-7"><div className="text-3xl font-black">★ {rating.value.toFixed(1)}</div><div className="mt-1 text-sm text-slate-500">{rating.count} customer review{rating.count === 1 ? "" : "s"}</div></div>}{cleaner.verified_identity && <div className="bg-white px-6 py-7"><div className="text-lg font-black">✓ Identity verified</div><div className="mt-1 text-sm text-slate-500">Verified by Klean.ly</div></div>}{cleaner.verified_card && <div className="bg-white px-6 py-7"><div className="text-lg font-black">✓ Payment verified</div><div className="mt-1 text-sm text-slate-500">Verified payment method on account</div></div>}</div></section>}

      {site.show_services && <section className="mx-auto max-w-7xl px-4 py-14 sm:px-6 sm:py-20"><div className="max-w-2xl"><p className="text-xs font-black uppercase tracking-[.18em]" style={{ color: site.primary_color }}>Services & pricing</p><h2 className="mt-3 text-3xl font-black tracking-tight sm:text-4xl">Choose your clean</h2><p className="mt-3 text-slate-600">Select a service below and we’ll pre-fill it in the booking form.</p></div>{services.length ? <div className="mt-9 grid gap-5 md:grid-cols-2 lg:grid-cols-3">{services.map((service) => <article key={service.id} className="flex min-h-[240px] flex-col rounded-[1.75rem] border border-slate-200 bg-white p-6 shadow-sm transition hover:-translate-y-0.5 hover:shadow-lg"><div className="flex h-11 w-11 items-center justify-center rounded-2xl text-lg font-black text-white" style={{ backgroundColor: site.primary_color }}>✓</div><h3 className="mt-5 text-xl font-black">{serviceName(service.service, service.variant)}</h3><div className="mt-3 text-3xl font-black">{price(service.price_cents) || "Price confirmed"}</div><p className="mt-2 text-sm leading-6 text-slate-500">Book this service directly with {businessName}.</p><button type="button" onClick={() => goToBooking(service.id)} className="mt-auto rounded-2xl px-5 py-3.5 font-black text-white" style={{ backgroundColor: site.primary_color }}>Book this clean</button></article>)}</div> : <div className="mt-8 rounded-3xl border bg-white p-8 text-slate-600">Services and pricing will appear here once published.</div>}</section>}

      {services.length > 0 && <section id="book-a-clean" className="scroll-mt-28 border-y border-slate-200 bg-slate-100/70"><div className="mx-auto grid max-w-7xl gap-8 px-4 py-14 sm:px-6 sm:py-20 lg:grid-cols-[.7fr_1.3fr] lg:items-start"><div className="lg:sticky lg:top-32"><p className="text-xs font-black uppercase tracking-[.18em]" style={{ color: site.primary_color }}>Online booking</p><h2 className="mt-3 text-3xl font-black tracking-tight sm:text-4xl">Book directly with {businessName}</h2><p className="mt-4 leading-7 text-slate-600">No directory redirect and no separate website. Pick your service, add your contact and cleaning address, then send the booking straight to the cleaner.</p><div className="mt-6 space-y-3 text-sm font-semibold text-slate-700"><div>✓ Choose from live services and prices</div><div>✓ Your booking goes directly to {businessName}</div><div>✓ The cleaner confirms the schedule with you</div></div></div><CleanerBookingForm cleanerId={cleaner.id} businessName={businessName} services={services} primaryColor={site.primary_color} accentColor={site.accent_color} selectedServiceId={bookingServiceId} /></div></section>}

      {site.show_service_areas && areas.length > 0 && <section className="text-white" style={{ backgroundColor: site.primary_color }}><div className="mx-auto max-w-7xl px-4 py-14 sm:px-6 sm:py-20"><p className="text-xs font-black uppercase tracking-[.18em]" style={{ color: site.accent_color }}>Coverage</p><h2 className="mt-3 text-3xl font-black sm:text-4xl">Areas we serve</h2><div className="mt-8 flex flex-wrap gap-3">{areas.map((area) => <span key={area.id} className="rounded-full border border-white/20 bg-white/10 px-4 py-2.5 font-bold">{area.name || "Local area"}</span>)}</div></div></section>}

      {site.show_gallery && gallery.length > 0 && <section className="bg-white"><div className="mx-auto max-w-7xl px-4 py-14 sm:px-6 sm:py-20"><p className="text-xs font-black uppercase tracking-[.18em]" style={{ color: site.primary_color }}>Our work</p><h2 className="mt-3 text-3xl font-black sm:text-4xl">Recent cleaning by {businessName}</h2><div className="mt-8 grid grid-cols-2 gap-3 sm:gap-5 md:grid-cols-3">{gallery.map((item) => <figure key={item.id} className="group overflow-hidden rounded-[1.75rem] bg-slate-100"><img src={item.image_url} alt={item.caption || `${businessName} work`} loading="lazy" className="aspect-square h-full w-full object-cover transition duration-300 group-hover:scale-[1.02]"/>{item.caption && <figcaption className="bg-white p-4 text-sm text-slate-600">{item.caption}</figcaption>}</figure>)}</div></div></section>}

      {site.show_about && <section className="border-t border-slate-200 bg-white"><div className="mx-auto grid max-w-7xl gap-8 px-4 py-14 sm:px-6 sm:py-20 lg:grid-cols-[1.15fr_.85fr]"><div><p className="text-xs font-black uppercase tracking-[.18em]" style={{ color: site.primary_color }}>About {businessName}</p><h2 className="mt-3 text-3xl font-black sm:text-4xl">Local service, direct contact</h2><p className="mt-5 max-w-2xl text-lg leading-8 text-slate-600">{intro}</p></div>{site.show_contact && <div className="rounded-[2rem] border border-slate-200 bg-slate-50 p-7"><div className="text-xl font-black">Contact {businessName}</div><div className="mt-5 space-y-5">{cleaner.phone && <a href={`tel:${cleaner.phone}`} onClick={() => recordEventFetch({ cleanerId: cleaner.id, event: "click_phone", meta: { source: "cleaner_site_contact" } }).catch(() => undefined)} className="block"><div className="text-xs font-bold uppercase tracking-wide text-slate-400">Phone</div><div className="mt-1 font-black">{cleaner.phone}</div></a>}{cleaner.contact_email && <a href={`mailto:${cleaner.contact_email}`} className="block"><div className="text-xs font-bold uppercase tracking-wide text-slate-400">Email</div><div className="mt-1 break-all font-black">{cleaner.contact_email}</div></a>}{cleaner.website && <a href={websiteUrl(cleaner.website)} target="_blank" rel="noreferrer" onClick={() => recordEventFetch({ cleanerId: cleaner.id, event: "click_website", meta: { source: "cleaner_site_contact" } }).catch(() => undefined)} className="block"><div className="text-xs font-bold uppercase tracking-wide text-slate-400">Website</div><div className="mt-1 break-all font-black">{cleaner.website}</div></a>}</div></div>}</div></section>}
    </main>

    <footer className="text-white/70" style={{ backgroundColor: site.primary_color }}><div className="mx-auto flex max-w-7xl flex-col gap-3 px-4 py-8 text-sm sm:flex-row sm:items-center sm:justify-between sm:px-6"><div className="flex items-center gap-3">{cleaner.logo_url && <img src={cleaner.logo_url} alt="" className="h-9 w-9 rounded-lg bg-white object-contain p-1" />}<span>© {new Date().getFullYear()} {businessName}</span></div>{!customDomain && <Link to="/" className="hover:text-white">Powered by Klean.ly</Link>}</div></footer>

    {services.length > 0 && <div className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-200 bg-white p-3 shadow-[0_-8px_30px_rgba(15,23,42,.12)] sm:hidden"><button type="button" onClick={() => goToBooking()} className="w-full rounded-2xl px-5 py-4 font-black" style={{ backgroundColor: site.accent_color, color: site.primary_color }}>Book a clean with {businessName}</button></div>}
  </div>;
}
