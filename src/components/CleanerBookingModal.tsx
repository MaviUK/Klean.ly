import { useEffect, useState, type FormEvent } from "react";
import { supabase } from "../lib/supabase";
import { recordEventFetch } from "../lib/analytics";

type Service = { id: string; service: string; variant: string | null; price_cents: number | null };
type Props = { open: boolean; onClose: () => void; cleanerId: string; businessName: string; services: Service[]; primaryColor: string; accentColor: string; initialServiceId?: string | null };

const serviceName = (service: Service) => {
  const name = service.service.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
  return service.variant ? `${name} · ${service.variant}` : name;
};
const price = (pence: number | null) => pence == null ? "Price confirmed by cleaner" : new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(pence / 100);

export default function CleanerBookingModal({ open, onClose, cleanerId, businessName, services, primaryColor, accentColor, initialServiceId }: Props) {
  const [serviceId, setServiceId] = useState(initialServiceId || services[0]?.id || "");
  const [name, setName] = useState(""); const [email, setEmail] = useState(""); const [phone, setPhone] = useState("");
  const [address, setAddress] = useState(""); const [postcode, setPostcode] = useState(""); const [notes, setNotes] = useState("");
  const [terms, setTerms] = useState(false); const [sending, setSending] = useState(false); const [sent, setSent] = useState(false); const [error, setError] = useState<string | null>(null);

  useEffect(() => { if (open) { setServiceId(initialServiceId || services[0]?.id || ""); setSent(false); setError(null); document.body.style.overflow = "hidden"; } return () => { document.body.style.overflow = ""; }; }, [open, initialServiceId, services]);
  useEffect(() => { if (!open) return; const close = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); }; window.addEventListener("keydown", close); return () => window.removeEventListener("keydown", close); }, [open, onClose]);
  if (!open) return null;
  const selected = services.find((service) => service.id === serviceId) || null;

  async function submit(event: FormEvent) {
    event.preventDefault(); setError(null);
    if (!selected) { setError("Please choose a service."); return; }
    if (!terms) { setError("Please confirm the booking terms before continuing."); return; }
    setSending(true);
    try {
      const acceptedAt = new Date().toISOString();
      const { error: insertError } = await supabase.from("cleaner_booking_requests").insert({
        cleaner_id: cleanerId, service_offering_id: selected.id, service_name: serviceName(selected), service_variant: selected.variant,
        price_cents: selected.price_cents, customer_name: name.trim(), email: email.trim(), phone: phone.trim(), address: address.trim(), postcode: postcode.trim() || null,
        notes: notes.trim() || null, terms_accepted: true, terms_version: "2026-08", terms_accepted_at: acceptedAt, source: "cleaner_site",
      });
      if (insertError) throw insertError;
      recordEventFetch({ cleanerId, event: "click_message", meta: { source: "cleaner_site_booking", service_id: selected.id } }).catch(() => undefined);
      setSent(true);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not send your booking request."); }
    finally { setSending(false); }
  }

  return <div className="fixed inset-0 z-[100] bg-black/65 backdrop-blur-sm p-3 sm:p-6 overflow-y-auto" role="dialog" aria-modal="true" aria-labelledby="booking-title" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="mx-auto my-3 sm:my-8 max-w-2xl overflow-hidden rounded-3xl bg-white shadow-2xl">
      <div className="p-6 sm:p-8 text-white" style={{ backgroundColor: primaryColor }}><div className="flex justify-between gap-4"><div><div className="text-xs font-bold uppercase tracking-[.2em]" style={{ color: accentColor }}>Book a clean</div><h2 id="booking-title" className="mt-2 text-3xl font-black">{businessName}</h2><p className="mt-2 text-white/75">Send your booking details directly to this cleaner.</p></div><button type="button" onClick={onClose} className="h-10 w-10 shrink-0 rounded-full border border-white/25 text-xl" aria-label="Close booking form">×</button></div></div>
      {sent ? <div className="p-7 sm:p-10 text-center"><div className="mx-auto grid h-16 w-16 place-items-center rounded-full text-2xl font-black" style={{ backgroundColor: accentColor, color: primaryColor }}>✓</div><h3 className="mt-5 text-2xl font-black">Booking request received</h3><p className="mt-3 text-slate-600">Your details have been sent to {businessName}. They can now arrange the clean and confirm the schedule with you.</p><button type="button" onClick={onClose} className="mt-7 rounded-full px-6 py-3 font-bold text-white" style={{ backgroundColor: primaryColor }}>Done</button></div> : <form onSubmit={submit} className="p-5 sm:p-8 space-y-6">
        <div><label className="text-sm font-bold">Cleaning service</label><div className="mt-2 grid gap-2">{services.map((service) => <label key={service.id} className={`flex cursor-pointer items-center justify-between gap-3 rounded-2xl border p-4 ${serviceId === service.id ? "ring-2" : ""}`} style={serviceId === service.id ? { borderColor: primaryColor } : undefined}><span className="flex items-center gap-3"><input type="radio" name="service" value={service.id} checked={serviceId === service.id} onChange={() => setServiceId(service.id)}/><span><span className="block font-bold">{serviceName(service)}</span><span className="block text-sm text-slate-500">{price(service.price_cents)}</span></span></span></label>)}</div></div>
        <div className="grid gap-4 sm:grid-cols-2"><label className="text-sm font-bold">Name<input required value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" className="mt-2 w-full rounded-xl border px-4 py-3 font-normal"/></label><label className="text-sm font-bold">Phone<input required value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="tel" inputMode="tel" className="mt-2 w-full rounded-xl border px-4 py-3 font-normal"/></label></div>
        <label className="block text-sm font-bold">Email<input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" className="mt-2 w-full rounded-xl border px-4 py-3 font-normal"/></label>
        <label className="block text-sm font-bold">Cleaning address<input required value={address} onChange={(e) => setAddress(e.target.value)} autoComplete="street-address" placeholder="House number, street, town" className="mt-2 w-full rounded-xl border px-4 py-3 font-normal"/></label>
        <div className="grid gap-4 sm:grid-cols-2"><label className="text-sm font-bold">Postcode<input value={postcode} onChange={(e) => setPostcode(e.target.value.toUpperCase())} autoComplete="postal-code" className="mt-2 w-full rounded-xl border px-4 py-3 font-normal"/></label><label className="text-sm font-bold">Anything we should know?<input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Access, bin location, etc." className="mt-2 w-full rounded-xl border px-4 py-3 font-normal"/></label></div>
        {selected && <div className="rounded-2xl bg-slate-50 border p-4 flex items-center justify-between gap-4"><div><div className="text-xs uppercase text-slate-500 font-bold">Selected service</div><div className="font-bold mt-1">{serviceName(selected)}</div></div><div className="text-xl font-black">{price(selected.price_cents)}</div></div>}
        <label className="flex items-start gap-3 text-sm text-slate-600"><input required type="checkbox" checked={terms} onChange={(e) => setTerms(e.target.checked)} className="mt-1"/><span>I confirm these details are correct and agree that {businessName} may contact me to arrange and confirm this booking. Submitting this form is a booking request until the cleaner confirms the schedule.</span></label>
        {error && <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}
        <button disabled={sending || services.length === 0} className="w-full rounded-2xl px-6 py-4 text-lg font-black disabled:opacity-50" style={{ backgroundColor: accentColor, color: primaryColor }}>{sending ? "Sending booking…" : "Send booking request"}</button>
      </form>}
    </div>
  </div>;
}
