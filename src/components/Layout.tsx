// src/components/Layout.tsx
import React, { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { supabase } from "../lib/supabase";

type LegalTab = "terms" | "privacy" | "cookies" | "sponsored";

function openLegal(tab: LegalTab) {
  window.dispatchEvent(new CustomEvent("open-legal", { detail: { tab } }));
}

type SupportType = "user" | "business";

type Attachment = {
  id: string;
  file: File;
  previewUrl: string;
};

const MAX_FILES = 5;
const MAX_FILE_MB = 5; // per file
const MAX_TOTAL_MB = 15; // total
const ACCEPTED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

function bytesToMb(n: number) {
  return n / (1024 * 1024);
}

function uid() {
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

const Layout: React.FC<React.PropsWithChildren> = ({ children }) => {
  const [authed, setAuthed] = useState(false);
  const location = useLocation();

  // Support modal state
  const [supportOpen, setSupportOpen] = useState(false);
  const [supportType, setSupportType] = useState<SupportType>("user");
  const [supportEmail, setSupportEmail] = useState("");
  const [supportSubject, setSupportSubject] = useState("");
  const [supportMessage, setSupportMessage] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [supportSending, setSupportSending] = useState(false);
  const [supportSent, setSupportSent] = useState<null | "ok" | "error">(null);
  const [supportErr, setSupportErr] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;

    (async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (mounted) setAuthed(!!session?.user);
    })();

    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      setAuthed(!!s?.user);
    });

    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  const hideCta = location.pathname === "/login";
  const WRAP = "mx-auto w-full max-w-7xl px-4 sm:px-6";

  const handleLogout = async () => {
    await supabase.auth.signOut();
  };

  const totalBytes = useMemo(
    () => attachments.reduce((sum, a) => sum + a.file.size, 0),
    [attachments]
  );

  const closeSupport = () => {
    setSupportOpen(false);
    // We intentionally do NOT wipe the fields on close,
    // so reopening doesn't lose text if they close by mistake.
  };

  const openSupport = () => {
    setSupportOpen(true);
    setSupportSent(null);
    setSupportErr(null);

    // best-effort prefill email from authed user
    supabase.auth.getUser().then(({ data }) => {
      const em = data?.user?.email;
      if (em && !supportEmail) setSupportEmail(em);
    });
  };

  const removeAttachment = (id: string) => {
    setAttachments((prev) => {
      const next = prev.filter((a) => a.id !== id);
      const removed = prev.find((a) => a.id === id);
      if (removed) URL.revokeObjectURL(removed.previewUrl);
      return next;
    });
  };

  const onPickFiles = (files: FileList | null) => {
    setSupportErr(null);
    if (!files) return;

    const incoming = Array.from(files);

    if (attachments.length + incoming.length > MAX_FILES) {
      setSupportErr(`You can attach up to ${MAX_FILES} images.`);
      return;
    }

    let nextBytes = totalBytes;
    const nextAttachments: Attachment[] = [];

    for (const f of incoming) {
      if (!ACCEPTED_IMAGE_TYPES.has(f.type)) {
        setSupportErr("Only image files are allowed (JPG, PNG, WebP, GIF).");
        return;
      }
      if (bytesToMb(f.size) > MAX_FILE_MB) {
        setSupportErr(`Each image must be under ${MAX_FILE_MB}MB.`);
        return;
      }
      nextBytes += f.size;
      if (bytesToMb(nextBytes) > MAX_TOTAL_MB) {
        setSupportErr(`Total attachments must be under ${MAX_TOTAL_MB}MB.`);
        return;
      }

      nextAttachments.push({
        id: uid(),
        file: f,
        previewUrl: URL.createObjectURL(f),
      });
    }

    setAttachments((prev) => [...prev, ...nextAttachments]);
  };

  const submitSupport = async (e: React.FormEvent) => {
    e.preventDefault();
    if (supportSending) return;

    setSupportSending(true);
    setSupportSent(null);
    setSupportErr(null);

    try {
      const fd = new FormData();
      fd.append("type", supportType);
      fd.append("email", supportEmail.trim());
      fd.append("subject", supportSubject.trim());
      fd.append("message", supportMessage.trim());

      attachments.forEach((a, i) => {
        fd.append(`attachment_${i + 1}`, a.file, a.file.name);
      });

      const res = await fetch("/.netlify/functions/support-ticket", {
        method: "POST",
        body: fd,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(text || `Support request failed (${res.status})`);
      }

      setSupportSent("ok");
      setSupportMessage("");
      setSupportSubject("");
      setAttachments((prev) => {
        prev.forEach((a) => URL.revokeObjectURL(a.previewUrl));
        return [];
      });
    } catch (err: any) {
      console.error(err);
      setSupportSent("error");
      setSupportErr(
        err?.message || "Sorry — something went wrong. Please try again."
      );
    } finally {
      setSupportSending(false);
    }
  };

  // Cleanup previews on unmount
  useEffect(() => {
    return () => {
      attachments.forEach((a) => URL.revokeObjectURL(a.previewUrl));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="min-h-screen flex flex-col bg-gray-50">
      {/* Header */}
      <header className="sticky top-0 z-30 border-b border-black/5 bg-white/80 backdrop-blur">
        <div className={`${WRAP} h-16 flex items-center justify-between`}>
          <Link to="/" className="inline-flex items-center gap-3">
            <img
              src="/cleanlylogo.png"
              alt="Klean.ly"
              className="h-16 w-16 object-contain"
              draggable={false}
            />
            <span className="font-extrabold tracking-tight text-gray-900 text-lg">
              Klean<span className="text-emerald-600">.</span>ly
            </span>
          </Link>

          {!hideCta && (
            <div className="flex items-center gap-3">
              {authed ? (
                <>
                  <Link
                    to="/dashboard"
                    className="inline-flex items-center rounded-xl px-4 py-2 text-sm font-semibold
                               bg-gray-900 text-white hover:bg-black
                               focus:outline-none focus:ring-4 focus:ring-black/20"
                  >
                    Dashboard
                  </Link>

                  <button
                    type="button"
                    onClick={handleLogout}
                    className="inline-flex items-center rounded-xl px-4 py-2 text-sm font-semibold
                               border border-gray-300 text-gray-700 hover:bg-gray-100
                               focus:outline-none focus:ring-4 focus:ring-black/10"
                  >
                    Log out
                  </button>
                </>
              ) : (
                <Link
                  to="/login?mode=signup"
                  className="inline-flex items-center rounded-xl px-4 py-2 text-sm font-semibold
                             bg-gray-900 text-white hover:bg-black
                             focus:outline-none focus:ring-4 focus:ring-black/20"
                >
                  Register a Business
                </Link>
              )}
            </div>
          )}
        </div>
      </header>

      {/* Page */}
      <main className="flex-1">{children}</main>

      {/* Footer */}
      <footer className="border-t border-black/5 bg-white">
        <div className={`${WRAP} py-6`}>
          <div className="flex flex-col sm:flex-row gap-3 sm:gap-0 items-center justify-between text-sm text-gray-500">
            <span>© {new Date().getFullYear()} Klean.ly</span>
            <span>
              Built with <span className="text-rose-600">❤</span>
            </span>
          </div>

          <div className="mt-3 flex flex-wrap items-center justify-center sm:justify-between gap-x-4 gap-y-2 text-xs text-gray-500">
            <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2">
              <button
                type="button"
                onClick={() => openLegal("terms")}
                className="hover:text-gray-900 underline underline-offset-4 decoration-gray-300"
              >
                Terms
              </button>
              <button
                type="button"
                onClick={() => openLegal("privacy")}
                className="hover:text-gray-900 underline underline-offset-4 decoration-gray-300"
              >
                Privacy
              </button>
              <button
                type="button"
                onClick={() => openLegal("cookies")}
                className="hover:text-gray-900 underline underline-offset-4 decoration-gray-300"
              >
                Cookies
              </button>
              <button
                type="button"
                onClick={() => openLegal("sponsored")}
                className="hover:text-gray-900 underline underline-offset-4 decoration-gray-300"
              >
                Sponsored Listing Terms
              </button>
            </div>

            <div className="text-xs text-gray-500">
              Questions?{" "}
              <button
                type="button"
                onClick={openSupport}
                className="font-semibold text-gray-900 underline underline-offset-2 hover:opacity-80"
              >
                Contact support
              </button>
            </div>
          </div>
        </div>
      </footer>

      {/* Support modal */}
      {supportOpen && (
        <div className="fixed inset-0 z-[120]">
          {/* backdrop */}
          <button
            className="absolute inset-0 bg-black/40"
            aria-label="Close support"
            onClick={closeSupport}
          />

          {/* panel */}
          <div className="relative mx-auto mt-4 w-[min(720px,92vw)] max-h-[92vh] rounded-2xl bg-white shadow-xl flex flex-col overflow-hidden">
            {/* header stays visible */}
            <div className="flex items-start justify-between gap-3 border-b border-gray-200 px-5 py-4">
              <div>
                <div className="text-lg font-semibold text-gray-900">
                  Contact support
                </div>
                <div className="text-sm text-gray-500">
                  We’ll reply by email as soon as possible.
                </div>
              </div>
              <button
                onClick={closeSupport}
                className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 hover:bg-gray-100"
              >
                Close
              </button>
            </div>

            {/* ONLY the form scrolls; buttons are inside form at bottom */}
            <form
              onSubmit={submitSupport}
              className="flex-1 overflow-y-auto px-5 py-5 space-y-4"
              style={{ WebkitOverflowScrolling: "touch" }}
            >
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700">
                    I am a…
                  </label>
                  <select
                    value={supportType}
                    onChange={(e) =>
                      setSupportType(e.target.value as SupportType)
                    }
                    className="mt-1 w-full rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm"
                  >
                    <option value="user">User</option>
                    <option value="business">Business</option>
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700">
                    Email
                  </label>
                  <input
                    type="email"
                    required
                    value={supportEmail}
                    onChange={(e) => setSupportEmail(e.target.value)}
                    className="mt-1 w-full rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm"
                    placeholder="you@example.com"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700">
                  Subject
                </label>
                <input
                  type="text"
                  required
                  value={supportSubject}
                  onChange={(e) => setSupportSubject(e.target.value)}
                  className="mt-1 w-full rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm"
                  placeholder="E.g. I can’t access my dashboard"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700">
                  Message
                </label>
                <textarea
                  required
                  rows={6}
                  value={supportMessage}
                  onChange={(e) => setSupportMessage(e.target.value)}
                  className="mt-1 w-full rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm"
                  placeholder="Tell us what’s going on…"
                />
              </div>

              <div>
                <div className="flex items-start justify-between gap-3">
                  <label className="block text-sm font-medium text-gray-700">
                    Attach images (optional)
                  </label>
                  <div className="text-xs text-gray-500 text-right">
                    Up to {MAX_FILES} · {MAX_FILE_MB}MB each · {MAX_TOTAL_MB}MB
                    total
                  </div>
                </div>

                <div className="mt-2">
                  <input
                    type="file"
                    accept="image/*"
                    multiple
                    onChange={(e) => {
                      onPickFiles(e.target.files);
                      e.currentTarget.value = "";
                    }}
                    className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-gray-900 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-white hover:file:bg-black"
                  />
                </div>

                {attachments.length > 0 && (
                  <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-3">
                    {attachments.map((a) => (
                      <div
                        key={a.id}
                        className="rounded-xl border border-gray-200 bg-gray-50 p-2"
                      >
                        <div className="aspect-square w-full overflow-hidden rounded-lg bg-white">
                          <img
                            src={a.previewUrl}
                            alt={a.file.name}
                            className="h-full w-full object-cover"
                          />
                        </div>
                        <div className="mt-2 flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="truncate text-xs font-medium text-gray-700">
                              {a.file.name}
                            </div>
                            <div className="text-[11px] text-gray-500">
                              {bytesToMb(a.file.size).toFixed(2)} MB
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => removeAttachment(a.id)}
                            className="shrink-0 rounded-md border border-gray-300 bg-white px-2 py-1 text-xs text-gray-700 hover:bg-gray-100"
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {supportErr && (
                  <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
                    {supportErr}
                  </div>
                )}
              </div>

              {supportSent === "ok" && (
                <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
                  Thanks — your message has been sent.
                </div>
              )}

              {supportSent === "error" && !supportErr && (
                <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
                  Sorry — something went wrong. Please try again.
                </div>
              )}

              {/* buttons are inside the scroll area (NOT sticky) */}
              <div className="pt-4 border-t border-gray-200 flex flex-col gap-2">
                <button
                  type="button"
                  onClick={closeSupport}
                  className="w-full rounded-xl border border-gray-300 px-4 py-3 text-sm font-semibold hover:bg-gray-50"
                >
                  Cancel
                </button>

                <button
                  type="submit"
                  disabled={supportSending}
                  className="w-full rounded-xl bg-gray-900 px-4 py-3 text-sm font-semibold text-white hover:bg-black disabled:opacity-60"
                >
                  {supportSending ? "Sending…" : "Send"}
                </button>

                <div className="text-xs text-gray-500 pt-1">
                  Tip: include your postcode (users) or business name (businesses)
                  so we can help faster.
                </div>

                {/* little spacer so iOS browser bars don't hide the last button */}
                <div style={{ height: "env(safe-area-inset-bottom)" }} />
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default Layout;
