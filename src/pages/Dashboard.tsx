// src/pages/Dashboard.tsx
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";
import CleanerOnboard from "../components/CleanerOnboard";
import ServiceAreaEditor from "../components/ServiceAreaEditor";
import AnalyticsOverview from "../components/AnalyticsOverview";

type Cleaner = {
  id: string;
  user_id: string;
  business_name: string | null;
  logo_url: string | null;
  address: string | null;
  slug: string;
  subscription_status: "active" | "incomplete" | "past_due" | "canceled" | null;
};

type CategoryTab = {
  id: string;
  name: string;
  slug: string;
};

// ✅ parse query params that are inside the hash (/#/dashboard?x=y)
function useHashQuery() {
  const { hash } = useLocation();
  return useMemo(() => {
    const qIndex = hash.indexOf("?");
    const search = qIndex >= 0 ? hash.slice(qIndex) : "";
    return new URLSearchParams(search);
  }, [hash]);
}

export default function Dashboard() {
  const [userId, setUserId] = useState<string | null>(null);
  const [cleaner, setCleaner] = useState<Cleaner | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [categories, setCategories] = useState<CategoryTab[]>([]);
  const [activeCategoryId, setActiveCategoryId] = useState<string | null>(null);

  const location = useLocation();
  const qsHash = useHashQuery();
  const navigate = useNavigate();

  const [banner, setBanner] = useState<null | { kind: "success" | "error"; msg: string }>(null);

  // bump used by ServiceAreaEditor to refetch sponsorship state
  const [sponsorshipVersion, setSponsorshipVersion] = useState(0);

  // hard refresh key to force full remount of the editor after checkout
  const [refreshKey, setRefreshKey] = useState(0);

  const [openingPortal, setOpeningPortal] = useState(false);

  const activeCategory = categories.find((c) => c.id === activeCategoryId) ?? null;

  // ✅ ensure checkout handling only runs once per load
  const handledCheckoutRef = useRef(false);

  // ✅ Handle checkout success/cancel whether params are in URL search (?checkout=...)
  // or inside hash (/#/dashboard?checkout=...)
  useEffect(() => {
    if (handledCheckoutRef.current) return;

    const qsSearch = new URLSearchParams(location.search);

    const status =
      qsSearch.get("checkout") ||
      qsHash.get("checkout") || // backward compat
      null;

    if (!status) return;

    handledCheckoutRef.current = true;

    const lockId =
      qsSearch.get("lock_id") ||
      qsHash.get("lock_id") ||
      null;

    // accept either session_id (Stripe standard in our success_url) or checkout_session (older)
    const sessionId =
      qsSearch.get("session_id") ||
      qsSearch.get("checkout_session") ||
      qsHash.get("session_id") ||
      qsHash.get("checkout_session") ||
      null;

    async function postVerify() {
      if (!sessionId) return;
      try {
        await fetch("/.netlify/functions/stripe-postverify", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ session_id: sessionId, checkout_session: sessionId }),
        });
      } catch {
        // non-fatal
      }
    }

    async function releaseLockIfAny() {
      if (!lockId) return;
      try {
        await fetch("/.netlify/functions/release-sponsored-lock", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ lock_id: lockId }),
        });
      } catch {
        // non-fatal
      }
    }

    function clearCheckoutParams() {
      // ✅ remove from BOTH places: URL search and hash query
      const cleanHash = (location.hash || "").replace(/\?.*$/g, "");
      navigate(
        { pathname: location.pathname, search: "", hash: cleanHash },
        { replace: true }
      );
    }

    (async () => {
      if (status === "success") {
        await postVerify();

        setBanner({
          kind: "success",
          msg: "Payment completed. Your sponsorship will appear shortly.",
        });

        // ✅ bump so we refetch sponsorship + repaint
        setSponsorshipVersion((v) => v + 1);
        setTimeout(() => setSponsorshipVersion((v) => v + 1), 2000);

        // ✅ hard remount editor (clears internal cached state)
        setRefreshKey((k) => k + 1);

        clearCheckoutParams();
      } else if (status === "cancel") {
        setBanner({ kind: "error", msg: "Checkout cancelled." });

        // ✅ release lock immediately (prevents “sold out” getting stuck)
        await releaseLockIfAny();

        // ✅ bump editor once so it refetches availability
        setSponsorshipVersion((v) => v + 1);
        setRefreshKey((k) => k + 1);

        clearCheckoutParams();
      } else {
        // unknown value -> just clear it
        clearCheckoutParams();
      }
    })();
    // IMPORTANT: include only stable deps
  }, [location.pathname, location.search, location.hash, qsHash, navigate]);

  // ✅ Load user + cleaner + active categories
  useEffect(() => {
    (async () => {
      try {
        const {
          data: { user },
          error: userErr,
        } = await supabase.auth.getUser();

        if (userErr) throw userErr;

        if (!user) {
          window.location.hash = "#/login";
          return;
        }

        setUserId(user.id);

        // Ensure cleaner row exists
        const { data: existing, error } = await supabase
          .from("cleaners")
          .select("*")
          .eq("user_id", user.id)
          .maybeSingle();

        if (error) throw error;

        let c: Cleaner | null = null;

        if (!existing) {
          const { data: created, error: insertErr } = await supabase
            .from("cleaners")
            .insert({
              user_id: user.id,
              business_name: user.email?.split("@")[0] || "My Cleaning Business",
              subscription_status: "active",
            })
            .select("*")
            .single();

          if (insertErr) throw insertErr;
          c = created as Cleaner;
        } else {
          c = existing as Cleaner;
        }

        setCleaner(c);

        // Load active categories (industries)
        const { data: cats, error: catErr } = await supabase
          .from("cleaner_category_offerings")
          .select("category_id, is_active, service_categories ( id, name, slug )")
          .eq("cleaner_id", c.id)
          .eq("is_active", true);

        if (catErr) {
          console.warn("Failed to load categories:", catErr);
          setCategories([]);
          setActiveCategoryId(null);
        } else {
          const mapped: CategoryTab[] = (cats || [])
            .map((r: any) => r?.service_categories)
            .filter(Boolean)
            .map((sc: any) => ({
              id: sc.id as string,
              name: sc.name as string,
              slug: sc.slug as string,
            }));

          const dedup = Array.from(new Map(mapped.map((x) => [x.id, x])).values()).sort((a, b) =>
            a.name.localeCompare(b.name)
          );

          setCategories(dedup);

          setActiveCategoryId((prev) => {
            if (prev && dedup.some((d) => d.id === prev)) return prev;
            return dedup[0]?.id ?? null;
          });
        }
      } catch (e: any) {
        setErr(e.message || "Failed to load dashboard.");
      } finally {
        setLoading(false);
      }
    })();
  }, [navigate]);

  async function openBillingPortal() {
    if (!cleaner) return;
    try {
      setOpeningPortal(true);
      const res = await fetch("/.netlify/functions/billing-portal", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cleanerId: cleaner.id }),
      });
      const data = await res.json();
      if (data?.url) window.location.href = data.url;
      else setBanner({ kind: "error", msg: data?.error || "Could not open billing portal." });
    } catch (e: any) {
      setBanner({ kind: "error", msg: e?.message || "Could not open billing portal." });
    } finally {
      setOpeningPortal(false);
    }
  }

  if (loading) {
    return <main className="container mx-auto max-w-6xl px-4 sm:px-6 py-8">Loading…</main>;
  }

  if (err) {
    return (
      <main className="container mx-auto max-w-6xl px-4 sm:px-6 py-8">
        <div className="card">
          <div className="card-pad text-red-600">{err}</div>
        </div>
      </main>
    );
  }

  if (!userId || !cleaner) {
    return (
      <main className="container mx-auto max-w-6xl px-4 sm:px-6 py-8">
        <div className="card">
          <div className="card-pad">No profile found.</div>
        </div>
      </main>
    );
  }

  const needsOnboard = !cleaner.business_name || !cleaner.address || !cleaner.logo_url;
  const industryKey = `${cleaner.id}:${activeCategoryId ?? "none"}`;

  return (
    <main className="container mx-auto max-w-6xl px-4 sm:px-6 py-8 space-y-8">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold">Cleaner Dashboard</h1>
          {activeCategory ? (
            <p className="muted mt-1">
              Managing: <span className="font-medium text-ink-900">{activeCategory.name}</span>
            </p>
          ) : (
            <p className="muted mt-1">Choose an industry to manage analytics & service areas.</p>
          )}
        </div>
      </div>

      {banner && (
        <section
          className={`rounded-lg border ${
            banner.kind === "success"
              ? "border-green-200 bg-green-50 text-green-800"
              : "border-red-200 bg-red-50 text-red-800"
          }`}
        >
          <div className="px-4 py-3 flex items-start justify-between gap-4">
            <div className="text-sm">{banner.msg}</div>
            <button className="text-xs opacity-70 hover:opacity-100" onClick={() => setBanner(null)}>
              Dismiss
            </button>
          </div>
        </section>
      )}

      {needsOnboard ? (
        <section className="card">
          <div className="card-pad space-y-4">
            <p className="muted">Welcome! Add your logo, business name, and address to complete your profile.</p>
            <CleanerOnboard
              userId={userId}
              cleaner={cleaner}
              onSaved={(patch) => setCleaner((prev) => (prev ? ({ ...prev, ...patch } as Cleaner) : prev))}
            />
          </div>
        </section>
      ) : (
        <>
          <section className="card">
            <div className="card-pad grid grid-cols-1 sm:grid-cols-[auto_1fr] lg:grid-cols-[auto_1fr_auto] gap-4">
              {cleaner.logo_url ? (
                <img
                  src={cleaner.logo_url}
                  alt="logo"
                  className="h-16 w-16 object-contain rounded-lg bg-white ring-1 ring-ink-100"
                />
              ) : (
                <div className="h-16 w-16 rounded-lg bg-ink-100" />
              )}

              <div className="min-w-0">
                <div className="font-semibold truncate">{cleaner.business_name}</div>
                <div className="muted truncate">{cleaner.address || "No address yet"}</div>
              </div>

              <div className="flex flex-col sm:flex-row gap-2 sm:justify-end lg:justify-start">
                <Link to="/settings" className="btn btn-primary w-full sm:w-auto">
                  Edit profile
                </Link>

                <Link to="/website" className="btn w-full sm:w-auto">
                  Website
                </Link>

                <Link to="/invoices" className="btn w-full sm:w-auto">
                  Invoices
                </Link>

                <button className="btn w-full sm:w-auto" onClick={openBillingPortal} disabled={openingPortal}>
                  {openingPortal ? "Opening…" : "Manage billing"}
                </button>
              </div>
            </div>
          </section>

          <section className="card">
            <div className="card-pad space-y-4">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div>
                  <h2 className="text-lg font-semibold">Industries</h2>
                  <p className="muted text-sm">Switch tabs like a browser.</p>
                </div>
                <Link to="/settings" className="text-sm underline">
                  Manage industries →
                </Link>
              </div>

              {categories.length ? (
                <div className="border-b border-ink-200 flex gap-1 overflow-x-auto">
                  {categories.map((t) => {
                    const active = t.id === activeCategoryId;
                    return (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => setActiveCategoryId(t.id)}
                        className={[
                          "relative -mb-px px-4 py-2 text-sm font-semibold whitespace-nowrap",
                          "border border-b-0 rounded-t-lg transition",
                          active
                            ? "bg-white text-ink-900 border-ink-300 shadow-[0_-1px_0_#fff,0_2px_10px_rgba(0,0,0,0.06)]"
                            : "bg-gray-100 text-gray-500 border-ink-200 hover:bg-gray-50 hover:text-gray-700",
                        ].join(" ")}
                      >
                        {t.name}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="rounded-xl border border-ink-100 bg-ink-50 px-4 py-3 text-sm text-ink-700">
                  You haven’t selected any industries yet. Go to{" "}
                  <Link className="underline" to="/settings">
                    Settings
                  </Link>{" "}
                  to choose what you offer.
                </div>
              )}

              {activeCategoryId ? (
                <div className="space-y-6" key={industryKey}>
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <h3 className="text-base font-semibold">Analytics</h3>
                      <span className="text-sm text-gray-500">This industry</span>
                    </div>

                    <AnalyticsOverview
                      key={`analytics:${industryKey}`}
                      cleanerId={cleaner.id}
                      categoryId={activeCategoryId}
                    />
                  </div>

                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <h3 className="text-base font-semibold">Your Service Areas</h3>
                    </div>

                    <div className="rounded-xl overflow-hidden border">
                      <ServiceAreaEditor
                        key={`areas:${industryKey}:${refreshKey}`}
                        cleanerId={cleaner.id}
                        sponsorshipVersion={sponsorshipVersion}
                        categoryId={activeCategoryId}
                      />
                    </div>
                  </div>
                </div>
              ) : (
                <div className="rounded-xl border border-ink-100 bg-ink-50 px-4 py-3 text-sm text-ink-700">
                  Select a tab above.
                </div>
              )}
            </div>
          </section>
        </>
      )}
    </main>
  );
}
