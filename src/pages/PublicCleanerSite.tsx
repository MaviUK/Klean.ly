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

  if (loading) return <div className="min-h-screen grid place-items-center bg-white">Loading…</div>;
  if (error) return <div className="min-h-screen grid place-items-center bg-white px-6"><div className="max-w-lg text-center"><h1 className="text-2xl font-bold mb-2">We couldn't load this cleaner</h1><p className="text-slate-600">{error}</p></div></div>;
  if (!cleaner || !site) return <div className="min-h-screen grid place-items-center bg-white px-6"><div className="max-w-lg text-center"><h1 className="text-3xl font-bold mb-3">Cleaner website unavailable</h1><p className="text-slate-600 mb-6">That business page isn't public right now.</p>{!customDomain && <Link to="/" className="inline-flex rounded-full bg-black px-5 py-3 text-white font-semibold">Back to Klean.ly</Link>}</div></div>;

  const callNumber = cleaner.phone || cleaner.whatsapp;
  const intro = site.description || cleaner.about || "Professional local cleaning with simple online booking and friendly service.";
  const businessName = cleaner.business_name || "Your cleaner";
  const goToBooking = (serviceId?: string) => {
    setBookingServiceId(serviceId || null);
    window.requestAnimationFrame(() => document.getElementById("book-a-clean")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };
  const goToContact = () => document.getElementById("contact")?.scrollIntoView({ behavior: "smooth", block: "start" });

  const benefitCards = [
    ["✧", "Professional equipment", "Professional cleaning equipment for a thorough, dependable clean."],
    ["✦", "Fresh, sanitised & odour free", "A fresher finish designed to leave bins cleaner and easier to live with."],
    ["✓", "Reliable scheduled cleaning", "Book directly with a local cleaner and keep your service simple."],
    ["▣", "Residential & commercial", "Cleaning services for homes, landlords and local businesses."],
  ];

  return <div className="min-h-screen bg-white text-[#22313f] pb-20 sm:pb-0">
    <main>
      <section className="bg-white px-5 pb-10 pt-8 text-center sm:pt-12">
        <div className="mx-auto max-w-xl">
          {cleaner.logo_url ? <img src={cleaner.logo_url} alt={`${businessName} logo`} className="mx-auto h-20 max-w-[230px] object-contain sm:h-24" /> : <div className="mx-auto grid h-20 w-20 place-items-center rounded-2xl text-3xl font-black text-white" style={{ backgroundColor: site.primary_color }}>{businessName[0].toUpperCase()}</div>}
          <div className="mt-8 inline-flex items-center gap-2 rounded-full bg-[#effaff] px-4 py-2 text-xs font-bold" style={{ color: site.primary_color }}><span>⌖</span><span>{areas[0]?.name ? `Now serving ${areas[0].name}` : "Now taking local bookings"}</span></div>
          <h1 className="mx-auto mt-5 max-w-md text-[2rem] font-black leading-[1.08] tracking-tight sm:text-5xl">{site.headline || <>Professional Cleaning Service <span style={{ color: site.primary_color }}>Now Available</span></>}</h1>
          <p className="mx-auto mt-5 max-w-md text-sm leading-6 text-slate-500 sm:text-base">{intro}</p>
          {rating && <div className="mt-4 text-sm font-bold text-slate-700">★ {rating.value.toFixed(1)} <span className="font-medium text-slate-400">({rating.count} reviews)</span></div>}
          <div className="mx-auto mt-7 grid max-w-md gap-3">
            <button type="button" disabled={!services.length} onClick={() => goToBooking()} className="rounded-xl px-6 py-3.5 font-black text-white shadow-sm disabled:opacity-50" style={{ background: `linear-gradient(90deg, ${site.primary_color}, ${site.accent_color})` }}>{services.length ? "Book Now" : "Booking unavailable"}</button>
            <button type="button" onClick={goToContact} className="rounded-xl border-2 bg-white px-6 py-3 font-black" style={{ borderColor: site.primary_color, color: site.primary_color }}>Contact Us</button>
          </div>
        </div>
      </section>

      <section className="bg-[#f2fbff] px-5 py-12 sm:py-16">
        <div className="mx-auto max-w-lg text-center"><h2 className="text-2xl font-black sm:text-3xl">Why Choose <span style={{ color: site.primary_color }}>{businessName}?</span></h2></div>
        <div className="mx-auto mt-8 grid max-w-lg gap-4">
          {benefitCards.map(([icon,title,body]) => <div key={title} className="rounded-[1.4rem] bg-white px-6 py-7 text-center shadow-[0_8px_28px_rgba(15,23,42,0.06)]"><div className="mx-auto grid h-11 w-11 place-items-center rounded-xl bg-[#effaff] text-lg font-black" style={{ color: site.primary_color }}>{icon}</div><h3 className="mt-4 text-base font-black">{title}</h3><p className="mx-auto mt-2 max-w-sm text-xs leading-5 text-slate-500 sm:text-sm">{body}</p></div>)}
        </div>
      </section>

      <section className="bg-white px-5 py-12 text-center sm:py-16">
        <div className="mx-auto max-w-md"><div className="inline-flex rounded-full bg-[#effcf7] px-3 py-1.5 text-[11px] font-bold" style={{ color: site.accent_color }}>✧ Book today</div><h2 className="mt-5 text-2xl font-black sm:text-3xl">Ready for a <span style={{ color: site.primary_color }}>Fresher Clean?</span></h2><p className="mt-4 text-sm leading-6 text-slate-500">Choose your service, enter your details and send your booking directly to {businessName}.</p><button type="button" onClick={() => goToBooking()} className="mt-6 rounded-xl px-6 py-3 font-black text-white shadow-sm" style={{ background: `linear-gradient(90deg, ${site.primary_color}, ${site.accent_color})` }}>Book a Clean</button></div>
      </section>

      <section className="bg-[#f2fbff] px-5 py-12 sm:py-16">
        <div className="mx-auto max-w-lg text-center"><h2 className="text-2xl font-black sm:text-3xl">How It <span style={{ color: site.primary_color }}>Works</span></h2></div>
        <div className="relative mx-auto mt-9 max-w-md">
          <div className="absolute left-1/2 top-8 h-[calc(100%-4rem)] w-px -translate-x-1/2 bg-slate-200" />
          {[["1","Choose Your Clean","Pick the service that suits you."],["2","Enter Your Details","Add your contact and cleaning address details."],["3","Send Your Booking","Your booking goes directly to the cleaner."],["4","Cleaner Confirms","The cleaner confirms the arrangement with you."]].map(([n,title,body]) => <div key={n} className="relative mb-8 text-center"><div className="relative z-10 mx-auto grid h-12 w-12 place-items-center rounded-2xl text-lg font-black text-white shadow-md" style={{ background: `linear-gradient(180deg, ${site.accent_color}, ${site.primary_color})` }}><span className="absolute -top-3 grid h-6 w-6 place-items-center rounded-full bg-emerald-400 text-[10px] text-white">{n}</span>✓</div><h3 className="mt-4 text-sm font-black">{title}</h3><p className="mx-auto mt-1 max-w-xs text-xs leading-5 text-slate-500">{body}</p></div>)}
        </div>
      </section>

      {site.show_services && <section className="bg-white px-5 py-12 sm:py-16"><div className="mx-auto max-w-lg text-center"><h2 className="text-2xl font-black sm:text-3xl">Choose Your <span style={{ color: site.primary_color }}>Service</span></h2><p className="mt-3 text-sm text-slate-500">Select a service to pre-fill the booking form.</p></div>{services.length ? <div className="mx-auto mt-7 grid max-w-lg gap-3">{services.map(service => <button key={service.id} type="button" onClick={() => goToBooking(service.id)} className="flex items-center justify-between gap-4 rounded-2xl border border-slate-100 bg-white p-5 text-left shadow-sm"><span><span className="block font-black">{serviceName(service.service, service.variant)}</span><span className="mt-1 block text-xs text-slate-500">Tap to book this clean</span></span><span className="shrink-0 text-lg font-black" style={{ color: site.primary_color }}>{price(service.price_cents) || "Ask"}</span></button>)}</div> : <p className="mt-7 text-center text-sm text-slate-500">Services will appear here once published.</p>}</section>}

      {site.show_gallery && gallery.length > 0 && <section className="bg-[#f2fbff] px-5 py-12 sm:py-16"><div className="mx-auto max-w-lg text-center"><h2 className="text-2xl font-black sm:text-3xl">Our <span style={{ color: site.primary_color }}>Work</span></h2></div><div className="mx-auto mt-7 grid max-w-lg grid-cols-2 gap-3">{gallery.map(item => <figure key={item.id} className="overflow-hidden rounded-2xl bg-white shadow-sm"><img src={item.image_url} alt={item.caption || `${businessName} cleaning work`} loading="lazy" className="aspect-square h-full w-full object-cover"/>{item.caption && <figcaption className="p-3 text-xs text-slate-500">{item.caption}</figcaption>}</figure>)}</div></section>}

      {site.show_service_areas && areas.length > 0 && <section className="bg-white px-5 py-12 sm:py-16"><div className="mx-auto max-w-lg text-center"><h2 className="text-2xl font-black sm:text-3xl">Areas We <span style={{ color: site.primary_color }}>Cover</span></h2><p className="mt-3 text-sm text-slate-500">Serving customers across our local service area.</p></div><div className="mx-auto mt-7 flex max-w-lg flex-wrap justify-center gap-2">{areas.map(area => <span key={area.id} className="rounded-full bg-[#f3f9fb] px-3.5 py-2 text-xs font-bold text-slate-700">⌖ {area.name || "Local area"}</span>)}</div></section>}

      <section id="book-a-clean" className="scroll-mt-6 bg-[#f2fbff] px-4 py-12 sm:px-5 sm:py-16"><div className="mx-auto max-w-xl"><div className="text-center"><h2 className="text-2xl font-black sm:text-3xl">Book Your <span style={{ color: site.primary_color }}>Clean</span></h2><p className="mx-auto mt-3 max-w-md text-sm leading-6 text-slate-500">Book directly with {businessName}. Choose a service and enter your details below.</p></div><div className="mt-7"><CleanerBookingForm cleanerId={cleaner.id} businessName={businessName} services={services} primaryColor={site.primary_color} accentColor={site.accent_color} initialServiceId={bookingServiceId} /></div></div></section>

      <section id="contact" className="scroll-mt-6 bg-white px-5 py-12 text-center sm:py-16"><div className="mx-auto max-w-md">{cleaner.logo_url && <img src={cleaner.logo_url} alt="" className="mx-auto h-14 max-w-[180px] object-contain"/>}<h2 className="mt-5 text-2xl font-black">Contact <span style={{ color: site.primary_color }}>{businessName}</span></h2>{site.show_about && <p className="mt-4 text-sm leading-6 text-slate-500">{intro}</p>}<div className="mt-6 grid gap-3">{callNumber && <a href={`tel:${callNumber}`} onClick={() => recordEventFetch({ cleanerId: cleaner.id, event: "click_phone", meta: { source: "cleaner_site_contact" } }).catch(() => undefined)} className="rounded-xl px-5 py-3.5 font-black text-white" style={{ backgroundColor: site.primary_color }}>Call {callNumber}</a>}{cleaner.contact_email && <a href={`mailto:${cleaner.contact_email}`} className="rounded-xl border-2 px-5 py-3.5 font-black" style={{ borderColor: site.primary_color, color: site.primary_color }}>Email Us</a>}{cleaner.website && <a href={websiteUrl(cleaner.website)} target="_blank" rel="noreferrer" className="text-sm font-bold text-slate-500">Visit website</a>}</div></div></section>
    </main>

    <footer className="bg-[#eef8fb] px-5 py-7 text-center text-xs text-slate-500"><div>© {new Date().getFullYear()} {businessName}</div>{!customDomain && <Link to="/" className="mt-2 inline-block font-bold" style={{ color: site.primary_color }}>Powered by Klean.ly</Link>}</footer>

    {services.length > 0 && <button type="button" onClick={() => goToBooking()} className="fixed bottom-4 left-4 right-4 z-40 rounded-xl px-5 py-4 text-center text-base font-black text-white shadow-2xl sm:hidden" style={{ background: `linear-gradient(90deg, ${site.primary_color}, ${site.accent_color})` }}>Book Now</button>}
  </div>;
}
