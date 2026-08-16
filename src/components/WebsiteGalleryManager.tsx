import { useEffect, useState, type ChangeEvent } from "react";
import { supabase } from "../lib/supabase";

type GalleryItem = { id: string; image_url: string; caption: string | null; sort_order: number };
type Props = { cleanerId: string };

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export default function WebsiteGalleryManager({ cleanerId }: Props) {
  const [items, setItems] = useState<GalleryItem[]>([]);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function load() {
    const { data, error } = await supabase.from("cleaner_gallery").select("id,image_url,caption,sort_order").eq("cleaner_id", cleanerId).order("sort_order").order("created_at");
    if (error) throw error;
    setItems((data ?? []) as GalleryItem[]);
  }

  useEffect(() => { load().catch((error: unknown) => setMessage(errorMessage(error, "Could not load gallery."))); }, [cleanerId]);

  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) { setMessage("Please choose an image file."); return; }
    if (file.size > 8 * 1024 * 1024) { setMessage("Images must be smaller than 8 MB."); return; }
    setUploading(true); setMessage(null);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Please sign in again.");
      const ext = file.name.split(".").pop()?.toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
      const path = `${user.id}/${cleanerId}/${crypto.randomUUID()}.${ext}`;
      const { error: uploadError } = await supabase.storage.from("cleaner-site-images").upload(path, file, { cacheControl: "3600", upsert: false, contentType: file.type });
      if (uploadError) throw uploadError;
      const { data: publicData } = supabase.storage.from("cleaner-site-images").getPublicUrl(path);
      const { error: insertError } = await supabase.from("cleaner_gallery").insert({ cleaner_id: cleanerId, image_url: publicData.publicUrl, sort_order: items.length });
      if (insertError) { await supabase.storage.from("cleaner-site-images").remove([path]); throw insertError; }
      await load(); setMessage("Photo added to your website gallery.");
    } catch (error: unknown) { setMessage(errorMessage(error, "Could not upload photo.")); }
    finally { setUploading(false); }
  }

  async function remove(item: GalleryItem) {
    setMessage(null);
    try {
      const { error } = await supabase.from("cleaner_gallery").delete().eq("id", item.id).eq("cleaner_id", cleanerId);
      if (error) throw error;
      const marker = "/cleaner-site-images/";
      const index = item.image_url.indexOf(marker);
      if (index >= 0) await supabase.storage.from("cleaner-site-images").remove([decodeURIComponent(item.image_url.slice(index + marker.length))]);
      await load();
    } catch (error: unknown) { setMessage(errorMessage(error, "Could not remove photo.")); }
  }

  return <section className="card"><div className="card-pad space-y-4"><div className="flex items-start justify-between gap-4 flex-wrap"><div><h2 className="text-lg font-semibold">Photo gallery</h2><p className="muted text-sm">Add before/after photos or examples of your work. Up to 8 MB per image.</p></div><label className={`btn btn-primary cursor-pointer ${uploading ? "opacity-60 pointer-events-none" : ""}`}>{uploading ? "Uploading…" : "Add photo"}<input type="file" accept="image/*" onChange={upload} className="hidden" disabled={uploading}/></label></div>{message && <div className="rounded-xl border bg-white px-4 py-3 text-sm">{message}</div>}{items.length === 0 ? <div className="rounded-xl border border-dashed p-5 text-sm text-gray-600">No gallery photos yet.</div> : <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">{items.map(item => <div key={item.id} className="group relative overflow-hidden rounded-2xl border bg-gray-100 aspect-square"><img src={item.image_url} alt={item.caption || "Cleaning work"} className="h-full w-full object-cover"/><button type="button" onClick={() => remove(item)} className="absolute right-2 top-2 rounded-full bg-black/70 px-3 py-1 text-xs font-semibold text-white opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition">Remove</button></div>)}</div>}</div></section>;
}
