import { useEffect, useState, type FormEvent } from "react";
import { supabase } from "../lib/supabase";
import { recordEventFetch } from "../lib/analytics";

type Service = { id: string; service: string; variant: string | null; price_cents: number | null };
type Props = {
  cleanerId: string;
  businessName: string;
  services: Service[];
  primaryColor: string;
  accentColor: string;
  selectedServiceId?: string | null;
  initialServiceId?: string | null;
};

const serviceName = (service: Service) => {
  const name = service.service.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
  return service.variant ? `${name} · ${service.variant}` : name;
};
const price = (pence: number | null) => pence == null ? "Price confirmed by cleaner" : new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(pence / 100);

export default function CleanerBookingForm({ cleanerId, businessName, services, primaryColor, accentColor, selectedServiceId, initialServiceId }: Props) {
  const preferredServiceId = selectedServiceId ?? initialServiceId ?? null;
  const [serviceId, setServiceId] = useState(preferredServiceId || services[0]?.id || "");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [postcode, setPostcode] = useState("");
  const [notes, setNotes] = useState("");
  const [terms, setTerms] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (preferredServiceId) setServiceId(preferredServiceId);
    else if (!serviceId && services[0]?.id) setServiceId(services[0].id);
  }, [preferredServiceId, services, serviceId]);

  const selected = services.find((service) => service.id === serviceId) || null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (!selected) { setError("Please choose a service."); return; }
    if (!terms) { setError("Please confirm the booking terms before continuing."); return; }
    setSending(true);
    try {
      const acceptedAt = new Date().toISOString();
      const { data, error: insertError } = await supabase.from("cleaner_booking_requests").insert({
        cleaner_id: cleanerId,
        service_offering_id: selected.id,
        service_name: serviceName(selected),
        service_variant: selected.variant,
        price_cents: selected.price_cents,
        customer_name: name.trim(),
        email: email.trim(),
        phone: phone.trim(),
        address: address.trim(),
        postcode: postcode.trim() || null,
        notes: notes.trim() || null,
        terms_accepted: true,
        terms_version: "2026-08",
        terms_accepted_at: acceptedAt,
        source: "cleaner_site",
      }).select("id").single();
      if (insertError) throw insertError;

      if (data?.id) {
        fetch("/.netlify/functions/booking-notification", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "new_booking", bookingId: data.id }),
        }).catch(() => undefined);
      }

      recordEventFetch({ cleanerId, event: "click_message", meta: { source: "cleaner_site_booking", service_id: selected.id } }).catch(() => undefined);
      setSent(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not send your booking request.");
    } finally {
      setSending(false);
    }
  }

  if (sent) {
    return <div className="rounded-[2rem] border border-emerald-200 bg-white p-7 text-center shadow-sm sm:p-10">
      <div className="mx-auto grid h-16 w-16 place-items-center rounded-full text-2xl font-black" style={{ backgroundColor: accentColor, color: primaryColor }}>✓</div>
      <h3 className="mt-5 text-2xl font-black">Booking request received</h3>
      <p className="mx-auto mt-3 max-w-lg text-slate-600">Your details have been sent to {businessName}. They can now confirm the clean with you.</p>
      <button type="button" onClick={() => { setSent(false); setName(""); setEmail(""); setPhone(""); setAddress(""); setPostcode(""); setNotes(""); setTerms(false); }} className="mt-6 rounded-full px-6 py-3 font-bold text-white" style={{ backgroundColor: primaryColor }}>Make another booking</button>
    </div>;
  }

  return <form onSubmit={submit} className="overflow-hidden rounded-[2rem] border border-slate-200 bg-white shadow-xl shadow-slate-900/5">
    <div className="p-6 text-white sm:p-8" style={{ backgroundColor: primaryColor }}>
      <div className="text-xs font-bold uppercase tracking-[.2em]" style={{ color: accentColor }}>Book online</div>
      <h2 className="mt-2 text-3xl font-black">Book a clean with {businessName}</h2>
      <p className="mt-2 max-w-xl text-white/75">Choose your service and send your details directly to the cleaner.</p>
    </div>

    <div className="space-y-6 p-5 sm:p-8">
      <div>
        <label className="text-sm font-bold text-slate-900">Choose a service</label>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {services.map((service) => <label key={service.id} className={`cursor-pointer rounded-2xl border p-4 transition ${serviceId === service.id ? "ring-2 shadow-sm" : "hover:bg-slate-50"}`} style={serviceId === service.id ? { borderColor: primaryColor, boxShadow: `0 0 0 1px ${primaryColor}` } : undefined}>
            <div className="flex items-start gap-3">
              <input type="radio" name="service" value={service.id} checked={serviceId === service.id} onChange={() => setServiceId(service.id)} className="mt-1" />
              <span><span className="block font-bold">{serviceName(service)}</span><span className="mt-1 block text-sm text-slate-500">{price(service.price_cents)}</span></span>
            </div>
          </label>)}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="text-sm font-bold">Name<input required value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" className="mt-2 w-full rounded-xl border border-slate-300 px-4 py-3 font-normal outline-none focus:ring-2" /></label>
        <label className="text-sm font-bold">Phone<input required value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="tel" inputMode="tel" className="mt-2 w-full rounded-xl border border-slate-300 px-4 py-3 font-normal outline-none focus:ring-2" /></label>
      </div>
      <label className="block text-sm font-bold">Email<input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" className="mt-2 w-full rounded-xl border border-slate-300 px-4 py-3 font-normal outline-none focus:ring-2" /></label>
      <label className="block text-sm font-bold">Cleaning address<input required value={address} onChange={(e) => setAddress(e.target.value)} autoComplete="street-address" placeholder="House number, street, town" className="mt-2 w-full rounded-xl border border-slate-300 px-4 py-3 font-normal outline-none focus:ring-2" /></label>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="text-sm font-bold">Postcode<input value={postcode} onChange={(e) => setPostcode(e.target.value.toUpperCase())} autoComplete="postal-code" className="mt-2 w-full rounded-xl border border-slate-300 px-4 py-3 font-normal outline-none focus:ring-2" /></label>
        <label className="text-sm font-bold">Anything we should know?<input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Access, bin location, etc." className="mt-2 w-full rounded-xl border border-slate-300 px-4 py-3 font-normal outline-none focus:ring-2" /></label>
      </div>

      {selected && <div className="flex items-center justify-between gap-4 rounded-2xl border bg-slate-50 p-4">
        <div><div className="text-xs font-bold uppercase tracking-wide text-slate-400">Your booking</div><div className="mt-1 font-bold">{serviceName(selected)}</div></div>
        <div className="text-xl font-black">{price(selected.price_cents)}</div>
      </div>}

      <label className="flex items-start gap-3 text-sm leading-6 text-slate-600"><input required type="checkbox" checked={terms} onChange={(e) => setTerms(e.target.checked)} className="mt-1" /><span>I confirm these details are correct and agree that {businessName} may contact me to arrange and confirm this booking.</span></label>
      {error && <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}
      <button disabled={sending || services.length === 0} className="w-full rounded-2xl px-6 py-4 text-lg font-black disabled:opacity-50" style={{ backgroundColor: accentColor, color: primaryColor }}>{sending ? "Sending booking…" : "Send booking request"}</button>
      <p className="text-center text-xs text-slate-400">Your booking is sent directly to {businessName} for confirmation.</p>
    </div>
  </form>;
}
