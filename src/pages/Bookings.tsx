import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabase";

type BookingStatus = "requested" | "quoted" | "confirmed" | "declined" | "cancelled";
type Booking = {
  id: string;
  service_name: string;
  service_variant: string | null;
  price_cents: number | null;
  customer_name: string;
  email: string;
  phone: string;
  address: string;
  postcode: string | null;
  notes: string | null;
  status: BookingStatus;
  terms_accepted_at: string | null;
  created_at: string;
};

const statusLabels: Record<BookingStatus, string> = {
  requested: "New request",
  quoted: "Quoted",
  confirmed: "Confirmed",
  declined: "Declined",
  cancelled: "Cancelled",
};
const statusClass: Record<BookingStatus, string> = {
  requested: "bg-amber-100 text-amber-900",
  quoted: "bg-blue-100 text-blue-900",
  confirmed: "bg-emerald-100 text-emerald-900",
  declined: "bg-slate-200 text-slate-700",
  cancelled: "bg-rose-100 text-rose-800",
};
const money = (pence: number | null) => pence == null ? "Price not set" : new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(pence / 100);
const when = (iso: string) => new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));

export default function Bookings() {
  const [cleanerId, setCleanerId] = useState<string | null>(null);
  const [businessName, setBusinessName] = useState<string>("Your business");
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<BookingStatus | "all">("all");
  const [savingId, setSavingId] = useState<string | null>(null);

  async function load() {
    setLoading(true); setError(null);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setLoading(false); return; }
    const { data: cleaner, error: cleanerError } = await supabase.from("cleaners").select("id,business_name").eq("user_id", user.id).maybeSingle();
    if (cleanerError) { setError(cleanerError.message); setLoading(false); return; }
    if (!cleaner) { setLoading(false); return; }
    setCleanerId(cleaner.id); setBusinessName(cleaner.business_name || "Your business");
    const { data, error: bookingError } = await supabase.from("cleaner_booking_requests")
      .select("id,service_name,service_variant,price_cents,customer_name,email,phone,address,postcode,notes,status,terms_accepted_at,created_at")
      .eq("cleaner_id", cleaner.id).order("created_at", { ascending: false });
    if (bookingError) setError(bookingError.message); else setBookings((data ?? []) as Booking[]);
    setLoading(false);
  }

  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (!cleanerId) return;
    const channel = supabase.channel(`booking-requests-${cleanerId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "cleaner_booking_requests", filter: `cleaner_id=eq.${cleanerId}` }, () => load())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [cleanerId]);

  const counts = useMemo(() => bookings.reduce((acc, booking) => { acc[booking.status] += 1; return acc; }, { requested: 0, quoted: 0, confirmed: 0, declined: 0, cancelled: 0 } as Record<BookingStatus, number>), [bookings]);
  const visible = filter === "all" ? bookings : bookings.filter((booking) => booking.status === filter);

  async function setStatus(id: string, status: BookingStatus) {
    setSavingId(id); setError(null);
    const { error: updateError } = await supabase.from("cleaner_booking_requests").update({ status, updated_at: new Date().toISOString() }).eq("id", id);
    if (updateError) setError(updateError.message); else setBookings((current) => current.map((booking) => booking.id === id ? { ...booking, status } : booking));
    setSavingId(null);
  }

  return <div className="mx-auto w-full max-w-7xl px-4 sm:px-6 py-8 sm:py-12">
    <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
      <div><p className="text-sm font-bold uppercase tracking-[.16em] text-emerald-600">Bookings</p><h1 className="mt-2 text-3xl sm:text-4xl font-black tracking-tight">Booking requests</h1><p className="mt-2 text-slate-600">Requests sent from the {businessName} mini-site appear here.</p></div>
      <Link to="/website" className="inline-flex w-fit rounded-xl border border-slate-300 bg-white px-4 py-2 font-semibold hover:bg-slate-50">Manage website</Link>
    </div>

    <div className="mt-8 grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {(["requested", "quoted", "confirmed", "declined", "cancelled"] as BookingStatus[]).map((status) => <button key={status} type="button" onClick={() => setFilter(filter === status ? "all" : status)} className={`rounded-2xl border bg-white p-4 text-left shadow-sm ${filter === status ? "ring-2 ring-emerald-500" : ""}`}><div className="text-2xl font-black">{counts[status]}</div><div className="mt-1 text-sm text-slate-500">{statusLabels[status]}</div></button>)}
    </div>

    {error && <div className="mt-6 rounded-2xl border border-red-200 bg-red-50 p-4 text-red-700">{error}</div>}
    {loading ? <div className="mt-10 text-slate-500">Loading bookings…</div> : visible.length === 0 ? <div className="mt-10 rounded-3xl border bg-white p-8 text-center"><h2 className="text-xl font-bold">No booking requests here yet</h2><p className="mt-2 text-slate-500">When customers use Book a clean on your mini-site, their request will show here.</p></div> : <div className="mt-8 grid gap-5">
      {visible.map((booking) => <article key={booking.id} className="overflow-hidden rounded-3xl border bg-white shadow-sm">
        <div className="flex flex-col gap-4 border-b p-5 sm:flex-row sm:items-start sm:justify-between sm:p-6">
          <div><div className="flex flex-wrap items-center gap-2"><h2 className="text-xl font-black">{booking.customer_name}</h2><span className={`rounded-full px-3 py-1 text-xs font-bold ${statusClass[booking.status]}`}>{statusLabels[booking.status]}</span></div><div className="mt-2 text-slate-600">{booking.service_name}</div><div className="mt-1 text-lg font-black">{money(booking.price_cents)}</div></div>
          <div className="text-sm text-slate-500 sm:text-right"><div>{when(booking.created_at)}</div>{booking.terms_accepted_at && <div className="mt-1">Booking consent recorded</div>}</div>
        </div>
        <div className="grid gap-6 p-5 sm:grid-cols-2 sm:p-6 lg:grid-cols-[1.1fr_1.1fr_.8fr]">
          <div><div className="text-xs font-bold uppercase tracking-wider text-slate-400">Customer</div><div className="mt-3 space-y-2 text-sm"><a className="block font-semibold hover:underline" href={`tel:${booking.phone}`}>{booking.phone}</a><a className="block font-semibold hover:underline break-all" href={`mailto:${booking.email}`}>{booking.email}</a></div></div>
          <div><div className="text-xs font-bold uppercase tracking-wider text-slate-400">Cleaning address</div><div className="mt-3 font-semibold">{booking.address}</div>{booking.postcode && <div className="mt-1 text-sm text-slate-500">{booking.postcode}</div>}{booking.notes && <div className="mt-3 rounded-xl bg-slate-50 p-3 text-sm text-slate-600"><span className="font-bold">Notes:</span> {booking.notes}</div>}</div>
          <div><div className="text-xs font-bold uppercase tracking-wider text-slate-400">Update status</div><select disabled={savingId === booking.id} value={booking.status} onChange={(event) => setStatus(booking.id, event.target.value as BookingStatus)} className="mt-3 w-full rounded-xl border px-3 py-2 font-semibold disabled:opacity-50"><option value="requested">New request</option><option value="quoted">Quoted</option><option value="confirmed">Confirmed</option><option value="declined">Declined</option><option value="cancelled">Cancelled</option></select><a href={`mailto:${booking.email}?subject=${encodeURIComponent(`Your ${booking.service_name} booking with ${businessName}`)}`} className="mt-3 block rounded-xl bg-slate-900 px-4 py-2 text-center text-sm font-bold text-white">Email customer</a></div>
        </div>
      </article>)}
    </div>}
  </div>;
}
