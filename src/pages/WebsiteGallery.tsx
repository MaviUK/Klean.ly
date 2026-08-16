import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import WebsiteGalleryManager from "../components/WebsiteGalleryManager";
import { supabase } from "../lib/supabase";

export default function WebsiteGallery() {
  const [cleanerId, setCleanerId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setLoading(false); return; }
      const { data } = await supabase.from("cleaners").select("id").eq("user_id", user.id).maybeSingle();
      setCleanerId(data?.id ?? null); setLoading(false);
    })();
  }, []);

  if (loading) return <main className="container mx-auto max-w-6xl px-4 sm:px-6 py-8">Loading gallery…</main>;
  return <main className="container mx-auto max-w-6xl px-4 sm:px-6 py-8 space-y-6"><div><Link to="/website" className="text-sm underline">← Website</Link><h1 className="text-2xl font-bold mt-2">Website Gallery</h1><p className="muted mt-1">Show customers examples of your work.</p></div>{cleanerId ? <WebsiteGalleryManager cleanerId={cleanerId}/> : <div className="card"><div className="card-pad">No cleaner profile found.</div></div>}</main>;
}
