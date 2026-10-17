import { useEffect, useState } from "react";
import { Link, NavLink, Navigate, Route, Routes } from "react-router-dom";
import { supabase } from "../lib/supabase";
import BusinessCustomers from "./BusinessCustomers";

type Business = { id: string; business_name: string | null };

function Overview({ cleanerId, businessName }: { cleanerId: string; businessName: string }) {
  const [count, setCount] = useState<number | null>(null);
  const [countError, setCountError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { count: total, error } = await supabase
        .from("business_customers")
        .select("id", { count: "exact", head: true })
        .eq("cleaner_id", cleanerId)
        .eq("status", "active");
      if (cancelled) return;
      setCountError(!!error);
      setCount(error ? null : (total ?? 0));
    })();
    return () => { cancelled = true; };
  }, [cleanerId]);

  return (
    <div className="space-y-6">
      <div className="rounded-3xl border border-emerald-100 bg-gradient-to-br from-emerald-50 to-white p-6 sm:p-9">
        <p className="text-xs font-bold uppercase tracking-[.15em] text-emerald-700">Business workspace</p>
        <h2 className="mt-2 text-2xl font-black tracking-tight text-slate-950 sm:text-3xl">
          Welcome to {businessName}
        </h2>
        <p className="mt-3 max-w-2xl text-slate-600">
          Manage your cleaning customers in one private workspace. Rounds, jobs, staff and payments
          will join this dashboard as we build them.
        </p>
        <Link to="/business/customers" className="mt-6 inline-flex rounded-xl bg-emerald-600 px-5 py-3 font-bold text-white hover:bg-emerald-700">
          Manage customers
        </Link>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-2xl border bg-white p-6 shadow-sm">
          <div className="text-sm font-semibold text-slate-500">Active customers</div>
          <div className="mt-2 text-4xl font-black text-slate-950">{countError ? "—" : count === null ? "…" : count}</div>
          {countError && <p className="mt-2 text-sm text-amber-700">Customer database setup is required before this count can load.</p>}
        </div>
        <div className="rounded-2xl border bg-white p-6 shadow-sm">
          <div className="text-sm font-semibold text-slate-500">Coming next</div>
          <p className="mt-2 font-bold text-slate-900">Recurring services and round scheduling</p>
          <p className="mt-1 text-sm text-slate-600">Customers will be connected to visits, routes and staff.</p>
        </div>
      </div>
    </div>
  );
}

export default function BusinessWorkspace() {
  const [business, setBusiness] = useState<Business | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const { data: { user }, error: authError } = await supabase.auth.getUser();
        if (authError) throw authError;
        if (!user) throw new Error("Please sign in to use Klean.ly Business.");
        const { data, error: cleanerError } = await supabase
          .from("cleaners")
          .select("id,business_name")
          .eq("user_id", user.id)
          .maybeSingle();
        if (cleanerError) throw cleanerError;
        if (!data) throw new Error("Set up your directory business profile first.");
        if (mounted) setBusiness(data as Business);
      } catch (cause) {
        if (mounted) setError(cause instanceof Error ? cause.message : "Could not load your business.");
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, []);

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-7 sm:px-6 sm:py-10">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-xs font-extrabold uppercase tracking-[.2em] text-emerald-700">Klean.ly Business</div>
          <h1 className="mt-1 text-2xl font-black tracking-tight text-slate-950 sm:text-3xl">
            {business?.business_name || "Business management"}
          </h1>
        </div>
        <Link to="/dashboard" className="text-sm font-semibold text-slate-600 underline underline-offset-4 hover:text-slate-900">
          Directory dashboard
        </Link>
      </div>

      {loading ? (
        <p className="rounded-2xl border bg-white p-6 text-slate-600">Loading your business…</p>
      ) : error || !business ? (
        <div className="rounded-2xl border bg-white p-6">
          <p className="font-semibold text-rose-700">{error || "Business profile not found."}</p>
          <Link className="mt-3 inline-block font-semibold text-emerald-700 underline" to="/dashboard">Open directory dashboard</Link>
        </div>
      ) : (
        <>
          <nav aria-label="Business navigation" className="mb-7 flex gap-2 overflow-x-auto border-b border-slate-200 pb-3">
            <NavLink end to="/business" className={({ isActive }) =>
              "whitespace-nowrap rounded-xl px-4 py-2 text-sm font-bold " +
              (isActive ? "bg-emerald-600 text-white" : "bg-white text-slate-700 hover:bg-slate-100")
            }>Overview</NavLink>
            <NavLink to="/business/customers" className={({ isActive }) =>
              "whitespace-nowrap rounded-xl px-4 py-2 text-sm font-bold " +
              (isActive ? "bg-emerald-600 text-white" : "bg-white text-slate-700 hover:bg-slate-100")
            }>Customers</NavLink>
          </nav>
          <Routes>
            <Route index element={<Overview cleanerId={business.id} businessName={business.business_name || "your business"} />} />
            <Route path="customers" element={<BusinessCustomers cleanerId={business.id} />} />
            <Route path="*" element={<Navigate to="/business" replace />} />
          </Routes>
        </>
      )}
    </div>
  );
}
