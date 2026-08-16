import { useState, type ChangeEvent } from "react";
import { supabase } from "../lib/supabase";

type Props = {
  cleanerId: string;
  value: string | null;
  onChange: (url: string) => void;
};

function message(error: unknown) {
  return error instanceof Error ? error.message : "Could not upload image.";
}

export default function WebsiteHeroUploader({ cleanerId, value, onChange }: Props) {
  const [uploading, setUploading] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) { setStatus("Please choose an image file."); return; }
    if (file.size > 8 * 1024 * 1024) { setStatus("Hero images must be smaller than 8 MB."); return; }

    setUploading(true);
    setStatus(null);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Please sign in again.");
      const ext = file.name.split(".").pop()?.toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
      const path = `${user.id}/${cleanerId}/hero-${crypto.randomUUID()}.${ext}`;
      const { error } = await supabase.storage.from("cleaner-site-images").upload(path, file, { cacheControl: "3600", contentType: file.type, upsert: false });
      if (error) throw error;
      const { data } = supabase.storage.from("cleaner-site-images").getPublicUrl(path);
      onChange(data.publicUrl);
      setStatus("Hero image uploaded. Save changes to publish it.");
    } catch (error: unknown) {
      setStatus(message(error));
    } finally {
      setUploading(false);
    }
  }

  return <div className="space-y-3">
    <div className="flex items-center justify-between gap-3 flex-wrap">
      <div><div className="text-sm font-medium">Hero image</div><div className="muted text-xs">Upload a wide photo of your team, van or work.</div></div>
      <label className={`btn cursor-pointer ${uploading ? "opacity-60 pointer-events-none" : ""}`}>{uploading ? "Uploading…" : value ? "Replace image" : "Upload image"}<input type="file" accept="image/*" className="hidden" onChange={upload} disabled={uploading}/></label>
    </div>
    {value && <div className="overflow-hidden rounded-2xl border bg-gray-100"><img src={value} alt="Website hero preview" className="h-40 w-full object-cover"/></div>}
    {status && <div className="text-xs text-gray-600">{status}</div>}
  </div>;
}
