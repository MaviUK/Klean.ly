import type { Handler } from "@netlify/functions";

const { getSupabaseAdmin } = require("./_lib/supabase");

type Action = "new_booking" | "status_changed";
type BookingStatus = "requested" | "quoted" | "confirmed" | "declined" | "cancelled";

const notifyStatuses = new Set<BookingStatus>(["confirmed", "declined", "cancelled"]);

export const handler: Handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Method Not Allowed" });

  try {
    const { bookingId, action } = JSON.parse(event.body || "{}") as { bookingId?: string; action?: Action };
    if (!bookingId || !action || !["new_booking", "status_changed"].includes(action)) return json(400, { error: "Invalid booking notification request." });

    const supabase = getSupabaseAdmin();
    const { data: booking, error: bookingError } = await supabase
      .from("cleaner_booking_requests")
      .select("id,cleaner_id,service_name,price_cents,customer_name,email,phone,address,postcode,notes,status,cleaner_notified_at,customer_notified_status")
      .eq("id", bookingId)
      .maybeSingle();
    if (bookingError) throw bookingError;
    if (!booking) return json(404, { error: "Booking not found." });

    const { data: cleaner, error: cleanerError } = await supabase
      .from("cleaners")
      .select("business_name,contact_email,user_id")
      .eq("id", booking.cleaner_id)
      .maybeSingle();
    if (cleanerError) throw cleanerError;
    if (!cleaner) return json(404, { error: "Cleaner not found." });

    const from = process.env.RESEND_FROM || process.env.ENQUIRY_FROM;
    const apiKey = process.env.RESEND_API_KEY;
    if (!from || !apiKey) return json(500, { error: "Email service is not configured." });

    if (action === "new_booking") {
      if (booking.cleaner_notified_at) return json(200, { ok: true, skipped: "already_notified" });
      if (!cleaner.contact_email) return json(200, { ok: true, skipped: "no_cleaner_email" });
      const business = cleaner.business_name || "your cleaning business";
      const subject = `New booking request for ${business}`;
      const html = emailShell(subject, `
        <p>You have a new booking request from <strong>${esc(booking.customer_name)}</strong>.</p>
        ${details(booking)}
        <p><a href="${siteUrl()}/bookings" style="display:inline-block;padding:12px 18px;border-radius:999px;background:#111827;color:#fff;text-decoration:none;font-weight:700">View booking</a></p>
        <p style="color:#64748b;font-size:13px">Reply directly to this email to contact ${esc(booking.customer_name)}.</p>`);
      await sendEmail(apiKey, from, cleaner.contact_email, subject, html, booking.email || undefined);
      await supabase.from("cleaner_booking_requests").update({ cleaner_notified_at: new Date().toISOString() }).eq("id", booking.id).is("cleaner_notified_at", null);
      return json(200, { ok: true });
    }

    const status = booking.status as BookingStatus;
    if (!notifyStatuses.has(status)) return json(200, { ok: true, skipped: "status_not_notifiable" });
    if (booking.customer_notified_status === status) return json(200, { ok: true, skipped: "already_notified" });
    if (!booking.email) return json(200, { ok: true, skipped: "no_customer_email" });

    const business = cleaner.business_name || "Your cleaner";
    const copy: Record<string, { subject: string; intro: string }> = {
      confirmed: { subject: `Your booking with ${business} is confirmed`, intro: `Good news — ${esc(business)} has confirmed your booking request.` },
      declined: { subject: `Update on your booking with ${business}`, intro: `${esc(business)} is unable to accept this booking request.` },
      cancelled: { subject: `Your booking with ${business} was cancelled`, intro: `Your booking with ${esc(business)} has been marked as cancelled.` },
    };
    const message = copy[status];
    const html = emailShell(message.subject, `<p>${message.intro}</p>${details(booking)}<p style="color:#64748b;font-size:13px">If you need more information, contact ${esc(business)} directly.</p>`);
    await sendEmail(apiKey, from, booking.email, message.subject, html, cleaner.contact_email || undefined);
    await supabase.from("cleaner_booking_requests").update({ customer_notified_status: status }).eq("id", booking.id);
    return json(200, { ok: true });
  } catch (error: any) {
    console.error("booking-notification", error);
    return json(500, { error: error?.message || "Could not send booking notification." });
  }
};

function details(booking: any) {
  const price = booking.price_cents == null ? "Price to be confirmed" : new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(booking.price_cents / 100);
  return `<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:16px;padding:16px;margin:18px 0"><p><strong>Service:</strong> ${esc(booking.service_name)}</p><p><strong>Price:</strong> ${esc(price)}</p><p><strong>Phone:</strong> ${esc(booking.phone || "-")}</p><p><strong>Address:</strong> ${esc([booking.address, booking.postcode].filter(Boolean).join(", "))}</p>${booking.notes ? `<p><strong>Notes:</strong> ${esc(booking.notes)}</p>` : ""}</div>`;
}
function emailShell(title: string, body: string) { return `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;line-height:1.55;color:#0f172a;max-width:620px;margin:auto"><h2>${esc(title)}</h2>${body}<hr style="border:0;border-top:1px solid #e2e8f0;margin:24px 0"><p style="color:#94a3b8;font-size:12px">Sent by Klean.ly</p></div>`; }
function siteUrl() { return (process.env.PUBLIC_SITE_URL || "https://klean.ly").replace(/\/$/, ""); }
async function sendEmail(apiKey: string, from: string, to: string, subject: string, html: string, replyTo?: string) {
  const response = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ from, to: [to], subject, html, reply_to: replyTo }) });
  if (!response.ok) throw new Error((await response.text().catch(() => "")) || "Resend returned an error.");
}
function json(statusCode: number, body: unknown) { return { statusCode, headers: { "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify(body) }; }
function esc(value: unknown) { return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&#039;"); }
