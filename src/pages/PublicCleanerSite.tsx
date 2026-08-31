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
  const intro = site.description || cleaner.about || "Professional local cleaning with simple online booking and friendly service.";
  const businessName = cleaner.business_name || "Your cleaner";
  const goToBooking = (serviceId?: string) => {
    setBookingServiceId(serviceId || null);
    window.requestAnimationFrame(() => document.getElementById("book-a-clean")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };

  return <div className="min-h-screen bg-white text-slate-950 pb-20 sm:pb-0">
    <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
        <div className="flex min-w-0 items-center gap-3 sm:gap-4">
          {cleaner.logo_url ? <img src={cleaner.logo_url} alt={`${businessName} logo`} className="h-14 w-14 shrink-0 rounded-xl object-contain sm:h-16 sm:w-16"/> : <div className="grid h-14 w-14 shrink-0 place-items-center rounded-xl text-xl font-black text-white sm:h-16 sm:w-16" style={{ backgroundColor: site.primary_color }}>{businessName[0].toUpperCase()}</div>}
          <div className="min-w-0"><div className="truncate text-lg font-black tracking-tight sm:text-2xl">{businessName}</div><div className="mt-0.5 text-xs font-medium text-slate-500 sm:text-sm">Professional local cleaning</div></div>
        </div>
        <div className="hidden items-center gap-3 sm:flex">
          {callNumber && <a href={`tel:${callNumber}`} onClick={() => recordEventFetch({ cleanerId: cleaner.id, event: "click_phone", meta: { source: "cleaner_site_header" } }).catch(() => undefined)} className="rounded-xl border border-slate-300 px-5 py-2.5 text-sm font-bold hover:bg-slate-50">Call</a>}
          <button type="button" disabled={!services.length} onClick={() => goToBooking()} className="rounded-xl px-5 py-2.5 text-sm font-black disabled:opacity-50" style={{ backgroundColor: site.accent_color, color: site.primary_color }}>Book now</button>
        </div>
      </div>
    </header>

    <main>
      <section className="relative overflow-hidden" style={{ backgroundColor: site.primary_color }}>
        {site.hero_url && <img src={site.hero_url} alt="" className="absolute inset-0 h-full w-full object-cover opacity-25" />}
        <div className="absolute inset-0 bg-gradient-to-r from-black/70 via-black/48 to-black/15" />
        <div className="relative mx-auto max-w-7xl px-4 py-16 text-white sm:px-6 sm:py-24 lg:py-28">
          <div className="max-w-3xl">
            <div className="mb-6 flex items-center gap-4">
              {cleaner.logo_url && <div className="rounded-2xl bg-white p-3 shadow-xl"><img src={cleaner.logo_url} alt={`${businessName} logo`} className="h-20 w-20 object-contain sm:h-24 sm:w-24" /></div>}
              <div><div className="text-sm font-black uppercase tracking-[.2em]" style={{ color: site.accent_color }}>{businessName}</div><div className="mt-2 text-sm font-semibold text-white/75">Simple online booking · Local service</div></div>
            </div>
            <h1 className="text-4xl font-black leading-tight tracking-tight sm:text-6xl lg:text-7xl">{site.headline || `Professional cleaning from ${businessName}`}</h1>
            <p className="mt-6 max-w-2xl text-lg leading-8 text-white/85 sm:text-xl">{intro}</p>
            <div className="mt-8 flex flex-wrap gap-3"><button type="button" disabled={!services.length} onClick={() => goToBooking()} className="rounded-xl px-7 py-4 text-base font-black shadow-lg disabled:opacity-50" style={{ backgroundColor: site.accent_color, color: site.primary_color }}>{services.length ? "Book a clean" : "Booking unavailable"}</button>{callNumber && <a href={`tel:${callNumber}`} className="rounded-xl border border-white/30 bg-white/10 px-7 py-4 text-base font-bold">Call now</a>}</div>
            <div className="mt-8 flex flex-wrap gap-2 text-sm font-semibold">{rating && <span className="rounded-lg border border-white/20 bg-white/10 px-3.5 py-2">★ {rating.value.toFixed(1)} · {rating.count} reviews</span>}{cleaner.verified_identity && <span className="rounded-lg border border-white/20 bg-white/10 px-3.5 py-2">✓ Identity verified</span>}{cleaner.verified_card && <span className="rounded-lg border border-white/20 bg-white/10 px-3.5 py-2">✓ Payment verified</span>}</div>
          </div>
        </div>
      </section>

      <section className="border-b bg-slate-50"><div className="mx-auto grid max-w-7xl gap-4 px-4 py-10 sm:grid-cols-2 sm:px-6 lg:grid-cols-4">
        {[['Powerful clean','Professional equipment for a thorough clean.'],['Fresh & sanitised','A cleaner, fresher bin after every visit.'],['Reliable service','Easy booking with a local cleaning business.'],['Homes & businesses','Services available for domestic and commercial customers.']].map(([title,body]) => <div key={title} className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200"><div className="mb-4 grid h-10 w-10 place-items-center rounded-xl text-lg font-black" style={{ backgroundColor: `${site.accent_color}33`, color: site.primary_color }}>✓</div><h2 className="text-lg font-black">{title}</h2><p className="mt-2 text-sm leading-6 text-slate-600">{body}</p></div>)}
      </div></section>

      {site.show_services && <section className="mx-auto max-w-7xl px-4 py-16 sm:px-6 sm:py-20"><div className="mx-auto max-w-2xl text-center"><p className="text-xs font-black uppercase tracking-[.2em]" style={{ color: site.primary_color }}>Our services</p><h2 className="mt-3 text-3xl font-black tracking-tight sm:text-4xl">Choose your clean</h2><p className="mt-3 text-slate-600">Select the service you need and book directly with {businessName}.</p></div>{services.length ? <div className="mt-10 grid gap-5 md:grid-cols-2 lg:grid-cols-3">{services.map((service) => <article key={service.id} className="flex flex-col rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"><h3 className="text-xl font-black">{serviceName(service.service, service.variant)}</h3><div className="mt-4 text-3xl font-black">{price(service.price_cents) || "Price on request"}</div><p className="mt-2 text-sm leading-6 text-slate-500">Book this service online in a few simple steps.</p><button type="button" onClick={() => goToBooking(service.id)} className="mt-6 rounded-xl px-5 py-3.5 font-black text-white" style={{ backgroundColor: site.primary_color }}>Book this service</button></article>)}</div> : <div className="mt-10 rounded-2xl border bg-slate-50 p-8 text-center text-slate-600">Services and pricing will appear here once published.</div>}</section>}

      <section className="bg-slate-950 text-white"><div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 sm:py-20"><div className="mx-auto max-w-2xl text-center"><p className="text-xs font-black uppercase tracking-[.2em]" style={{ color: site.accent_color }}>How it works</p><h2 className="mt-3 text-3xl font-black sm:text-4xl">Booking your clean is simple</h2></div><div className="mt-12 grid gap-8 md:grid-cols-3">{[['1','Choose your service','Pick the cleaning service that suits you.'],['2','Send your details','Enter your contact and cleaning address details.'],['3','Cleaner confirms','Your cleaner receives the booking and confirms the arrangement.']].map(([n,title,body]) => <div key={n} className="text-center"><div className="mx-auto grid h-14 w-14 place-items-center rounded-full text-xl font-black" style={{ backgroundColor: site.accent_color, color: site.primary_color }}>{n}</div><h3 className="mt-5 text-xl font-black">{title}</h3><p className="mt-2 text-sm leading-6 text-white/65">{body}</p></div>)}</div></div></section>

      {site.show_gallery && gallery.length > 0 && <section className="bg-slate-50"><div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 sm:py-20"><div className="mx-auto max-w-2xl text-center"><p className="text-xs font-black uppercase tracking-[.2em]" style={{ color: site.primary_color }}>Our work</p><h2 className="mt-3 text-3xl font-black sm:text-4xl">Recent cleaning</h2></div><div className="mt-10 grid grid-cols-2 gap-4 md:grid-cols-3">{gallery.map((item) => <figure key={item.id} className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-200"><img src={item.image_url} alt={item.caption || `${businessName} cleaning work`} loading="lazy" className="aspect-square h-full w-full object-cover"/>{item.caption && <figcaption className="p-4 text-sm text-slate-600">{item.caption}</figcaption>}</figure>)}</div></div></section>}

      {site.show_service_areas && areas.length > 0 && <section className="bg-white"><div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 sm:py-20"><div className="mx-auto max-w-2xl text-center"><p className="text-xs font-black uppercase tracking-[.2em]" style={{ color: site.primary_color }}>Areas we cover</p><h2 className="mt-3 text-3xl font-black sm:text-4xl">Serving customers locally</h2></div><div className="mx-auto mt-9 flex max-w-4xl flex-wrap justify-center gap-3">{areas.map((area) => <span key={area.id} className="rounded-xl bg-slate-100 px-4 py-2.5 text-sm font-bold text-slate-700">{area.name || "Local area"}</span>)}</div></div></section>}

      <section id="book-a-clean" className="scroll-mt-24 border-y bg-slate-50"><div className="mx-auto grid max-w-7xl gap-10 px-4 py-16 sm:px-6 sm:py-20 lg:grid-cols-[.75fr_1.25fr] lg:items-start"><div className="lg:sticky lg:top-28"><p className="text-xs font-black uppercase tracking-[.2em]" style={{ color: site.primary_color }}>Book online</p><h2 className="mt-3 text-3xl font-black tracking-tight sm:text-4xl">Book a clean with {businessName}</h2><p className="mt-4 text-lg leading-8 text-slate-600">Choose a service and send your booking details directly to the cleaner.</p><div className="mt-7 space-y-3 text-sm text-slate-600"><div>✓ Quick online booking</div><div>✓ Service and price selected upfront</div><div>✓ Booking goes directly to {businessName}</div></div>{callNumber && <a href={`tel:${callNumber}`} className="mt-7 inline-flex rounded-xl border border-slate-300 bg-white px-5 py-3 font-bold">Prefer to call? {callNumber}</a>}</div><CleanerBookingForm cleanerId={cleaner.id} businessName={businessName} services={services} primaryColor={site.primary_color} accentColor={site.accent_color} initialServiceId={bookingServiceId} /></div></section>

      {site.show_about && <section className="bg-white"><div className="mx-auto grid max-w-7xl gap-10 px-4 py-16 sm:px-6 sm:py-20 lg:grid-cols-2"><div><p className="text-xs font-black uppercase tracking-[.2em]" style={{ color: site.primary_color }}>About us</p><h2 className="mt-3 text-3xl font-black sm:text-4xl">Local service from {businessName}</h2><p className="mt-5 max-w-2xl text-base leading-7 text-slate-600">{intro}</p></div>{site.show_contact && <div className="rounded-2xl bg-slate-50 p-7 ring-1 ring-slate-200"><h3 className="text-xl font-black">Contact {businessName}</h3><div className="mt-5 space-y-4">{cleaner.phone && <a href={`tel:${cleaner.phone}`} className="block"><div className="text-xs font-bold uppercase text-slate-400">Phone</div><div className="mt-1 font-black">{cleaner.phone}</div></a>}{cleaner.contact_email && <a href={`mailto:${cleaner.contact_email}`} className="block"><div className="text-xs font-bold uppercase text-slate-400">Email</div><div className="mt-1 break-all font-black">{cleaner.contact_email}</div></a>}{cleaner.website && <a href={websiteUrl(cleaner.website)} target="_blank" rel="noreferrer" className="block"><div className="text-xs font-bold uppercase text-slate-400">Website</div><div className="mt-1 break-all font-black">{cleaner.website}</div></a>}</div></div>}</div></section>}
    </main>

    <footer style={{ backgroundColor: site.primary_color }} className="text-white"><div className="mx-auto flex max-w-7xl flex-col gap-3 px-4 py-8 text-sm sm:flex-row sm:items-center sm:justify-between sm:px-6"><div className="flex items-center gap-3">{cleaner.logo_url && <img src={cleaner.logo_url} alt="" className="h-10 w-10 rounded-lg bg-white object-contain p-1"/>}<span className="font-bold">© {new Date().getFullYear()} {businessName}</span></div>{!customDomain && <Link to="/" className="text-white/70 hover:text-white">Powered by Klean.ly</Link>}</div></footer>

    {services.length > 0 && <button type="button" onClick={() => goToBooking()} className="fixed bottom-4 left-4 right-4 z-40 rounded-xl px-5 py-4 text-center text-base font-black shadow-2xl sm:hidden" style={{ backgroundColor: site.accent_color, color: site.primary_color }}>Book a clean with {businessName}</button>}
  </div>;
}
