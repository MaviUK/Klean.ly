import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { supabase } from "../lib/supabase";

type CustomerStatus = "active" | "archived";

type Customer = {
  id: string;
  full_name: string;
  phone: string | null;
  email: string | null;
  address_line1: string | null;
  address_line2: string | null;
  town: string | null;
  postcode: string | null;
  notes: string | null;
  status: CustomerStatus;
  created_at: string;
};

type CustomerForm = {
  full_name: string;
  phone: string;
  email: string;
  address_line1: string;
  address_line2: string;
  town: string;
  postcode: string;
  notes: string;
};

const PAGE_SIZE = 40;
const FIELDS = "id,full_name,phone,email,address_line1,address_line2,town,postcode,notes,status,created_at";

function blankForm(): CustomerForm {
  return { full_name: "", phone: "", email: "", address_line1: "", address_line2: "", town: "", postcode: "", notes: "" };
}

function errorText(error: { message: string; code?: string } | null) {
  if (!error) return "An unexpected error occurred.";
  if (error.code === "42P01" || error.code === "42501") {
    return "The customer database is not ready yet. An administrator needs to apply the business-customers database setup.";
  }
  return error.message;
}

function address(customer: Customer) {
  return [customer.address_line1, customer.address_line2, customer.town, customer.postcode]
    .filter(Boolean)
    .join(", ");
}

export default function BusinessCustomers({ cleanerId }: { cleanerId: string }) {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [status, setStatus] = useState<CustomerStatus>("active");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<CustomerForm>(blankForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [changingStatusId, setChangingStatusId] = useState<string | null>(null);
  const requestNumber = useRef(0);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  const loadPage = useCallback(async (offset: number) => {
    const request = ++requestNumber.current;
    if (offset === 0) {
      setLoading(true);
      setCustomers([]);
    } else {
      setLoadingMore(true);
    }
    setError(null);

    let query = supabase.from("business_customers")
      .select(FIELDS)
      .eq("cleaner_id", cleanerId)
      .eq("status", status)
      .order("created_at", { ascending: false })
      .range(offset, offset + PAGE_SIZE - 1);

    const term = debouncedSearch.replace(/[%_]/g, "").slice(0, 120);
    if (term) query = query.ilike("search_text", "%" + term + "%");

    const { data, error: fetchError } = await query;
    if (request !== requestNumber.current) return;
    if (fetchError) {
      setError(errorText(fetchError));
      setHasMore(false);
    } else {
      const next = (data ?? []) as Customer[];
      setCustomers((previous) => offset === 0 ? next : [...previous, ...next]);
      setHasMore(next.length === PAGE_SIZE);
    }
    setLoading(false);
    setLoadingMore(false);
  }, [cleanerId, status, debouncedSearch]);

  useEffect(() => {
    void loadPage(0);
    return () => { requestNumber.current += 1; };
  }, [loadPage]);

  function startAdd() {
    setEditingId(null);
    setForm(blankForm());
    setFormError(null);
    setEditorOpen(true);
  }

  function startEdit(customer: Customer) {
    setEditingId(customer.id);
    setForm({
      full_name: customer.full_name,
      phone: customer.phone ?? "",
      email: customer.email ?? "",
      address_line1: customer.address_line1 ?? "",
      address_line2: customer.address_line2 ?? "",
      town: customer.town ?? "",
      postcode: customer.postcode ?? "",
      notes: customer.notes ?? "",
    });
    setFormError(null);
    setEditorOpen(true);
  }

  function setField(field: keyof CustomerForm, value: string) {
    setForm((previous) => ({ ...previous, [field]: value }));
  }

  async function saveCustomer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    if (!form.full_name.trim()) {
      setFormError("Enter the customer's name.");
      return;
    }

    setSaving(true);
    setFormError(null);
    const values = {
      full_name: form.full_name.trim(),
      phone: form.phone.trim() || null,
      email: form.email.trim() || null,
      address_line1: form.address_line1.trim() || null,
      address_line2: form.address_line2.trim() || null,
      town: form.town.trim() || null,
      postcode: form.postcode.trim().toUpperCase() || null,
      notes: form.notes.trim() || null,
      updated_at: new Date().toISOString(),
    };

    try {
      const result = editingId
        ? await supabase.from("business_customers")
            .update(values)
            .eq("id", editingId)
            .eq("cleaner_id", cleanerId)
            .select("id")
            .single()
        : await supabase.from("business_customers")
            .insert({ ...values, cleaner_id: cleanerId })
            .select("id")
            .single();

      if (result.error) throw result.error;
      setEditorOpen(false);
      setEditingId(null);
      await loadPage(0);
    } catch (cause) {
      const databaseError = cause as { message: string; code?: string };
      setFormError(errorText(databaseError));
    } finally {
      setSaving(false);
    }
  }

  async function changeStatus(customer: Customer) {
    const next: CustomerStatus = customer.status === "active" ? "archived" : "active";
    if (next === "archived" && !window.confirm("Archive " + customer.full_name + "? You can restore this customer later.")) return;

    setChangingStatusId(customer.id);
    setError(null);
    const { data, error: updateError } = await supabase.from("business_customers")
      .update({ status: next, updated_at: new Date().toISOString() })
      .eq("id", customer.id)
      .eq("cleaner_id", cleanerId)
      .select("id")
      .maybeSingle();

    if (updateError) setError(errorText(updateError));
    else if (!data) setError("This customer could not be updated. Please reload and try again.");
    else await loadPage(0);
    setChangingStatusId(null);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-extrabold uppercase tracking-[.18em] text-emerald-700">Customer management</p>
          <h2 className="mt-1 text-2xl font-black tracking-tight text-slate-950 sm:text-3xl">Customers</h2>
          <p className="mt-2 text-sm text-slate-600">Private customer records for your business. Nothing here appears in the public directory.</p>
        </div>
        <button type="button" onClick={startAdd} className="rounded-xl bg-emerald-600 px-5 py-3 font-bold text-white hover:bg-emerald-700">
          + Add customer
        </button>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <label className="min-w-0 flex-1">
            <span className="sr-only">Search customers</span>
            <input type="search" value={search} onChange={(event) => setSearch(event.target.value)}
              placeholder="Search name, phone, address or postcode…"
              className="w-full rounded-xl border border-slate-300 px-4 py-3 text-slate-950 outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100" />
          </label>
          <div className="flex shrink-0 gap-2" role="group" aria-label="Customer status">
            <button type="button" aria-pressed={status === "active"} onClick={() => setStatus("active")}
              className={"rounded-xl px-4 py-3 text-sm font-bold " + (status === "active" ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-700")}>Active</button>
            <button type="button" aria-pressed={status === "archived"} onClick={() => setStatus("archived")}
              className={"rounded-xl px-4 py-3 text-sm font-bold " + (status === "archived" ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-700")}>Archived</button>
          </div>
        </div>
        {error && <div role="alert" className="mt-4 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">{error}</div>}
        {loading ? (
          <p className="py-12 text-center text-slate-500">Loading customers…</p>
        ) : customers.length === 0 && !error ? (
          <div className="py-12 text-center">
            <h3 className="text-lg font-bold text-slate-900">{search ? "No matching customers" : status === "archived" ? "No archived customers" : "No customers added yet"}</h3>
            <p className="mt-2 text-sm text-slate-500">{search ? "Try a different search." : status === "archived" ? "Archived customer records will appear here." : "Start by adding your first customer."}</p>
            {!search && status === "active" && <button type="button" onClick={startAdd} className="mt-4 font-bold text-emerald-700 underline">Add first customer</button>}
          </div>
        ) : (
          <>
            <div className="mt-5 overflow-x-auto">
              <table className="w-full min-w-[620px] text-left text-sm">
                <thead className="border-b text-xs font-extrabold uppercase tracking-wider text-slate-500">
                  <tr>
                    <th className="pb-3 pr-4">Customer</th>
                    <th className="pb-3 pr-4">Address</th>
                    <th className="pb-3 pr-4">Contact</th>
                    <th className="pb-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {customers.map((customer) => (
                    <tr key={customer.id} className="align-top">
                      <td className="py-4 pr-4 font-bold text-slate-950">{customer.full_name}</td>
                      <td className="py-4 pr-4 text-slate-600">{address(customer) || "Not added"}</td>
                      <td className="py-4 pr-4 text-slate-600">
                        {customer.phone && <div>{customer.phone}</div>}
                        {customer.email && <div className="max-w-[230px] break-all">{customer.email}</div>}
                        {!customer.phone && !customer.email && "Not added"}
                      </td>
                      <td className="py-4 text-right">
                        <div className="flex justify-end gap-3 whitespace-nowrap">
                          <button type="button" onClick={() => startEdit(customer)} className="font-bold text-emerald-700 hover:underline">Edit</button>
                          <button type="button" disabled={changingStatusId === customer.id}
                            onClick={() => void changeStatus(customer)} className="font-bold text-slate-600 hover:underline disabled:opacity-50">
                            {customer.status === "active" ? "Archive" : "Restore"}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t pt-4 text-sm text-slate-500">
              <span>Showing {customers.length} {status} customer{customers.length === 1 ? "" : "s"}</span>
              {hasMore && <button type="button" disabled={loadingMore} onClick={() => void loadPage(customers.length)}
                className="rounded-xl border border-slate-300 px-4 py-2 font-bold text-slate-800 hover:bg-slate-50 disabled:opacity-50">
                {loadingMore ? "Loading…" : "Load more"}
              </button>}
            </div>
          </>
        )}
      </div>

      {editorOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-3 sm:p-6">
          <button type="button" aria-label="Close customer editor" className="absolute inset-0 bg-slate-950/60"
            onClick={() => { if (!saving) setEditorOpen(false); }} />
          <div role="dialog" aria-modal="true" aria-labelledby="customer-editor-title"
            className="relative max-h-[94vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-5 shadow-2xl sm:p-7">
            <div className="mb-5 flex items-start justify-between gap-4">
              <div>
                <h3 id="customer-editor-title" className="text-xl font-black text-slate-950">{editingId ? "Edit customer" : "Add customer"}</h3>
                <p className="mt-1 text-sm text-slate-500">Only your business can access this record.</p>
              </div>
              <button type="button" disabled={saving} onClick={() => setEditorOpen(false)}
                aria-label="Close" className="rounded-lg p-2 text-slate-600 hover:bg-slate-100 disabled:opacity-50">✕</button>
            </div>
            <form onSubmit={(event) => void saveCustomer(event)} className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="sm:col-span-2">
                  <span className="text-sm font-bold text-slate-800">Customer name *</span>
                  <input required maxLength={160} value={form.full_name} onChange={(event) => setField("full_name", event.target.value)}
                    className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2.5 focus:border-emerald-500 focus:outline-none" />
                </label>
                <label>
                  <span className="text-sm font-bold text-slate-800">Telephone</span>
                  <input type="tel" maxLength={50} value={form.phone} onChange={(event) => setField("phone", event.target.value)}
                    className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2.5 focus:border-emerald-500 focus:outline-none" />
                </label>
                <label>
                  <span className="text-sm font-bold text-slate-800">Email</span>
                  <input type="email" maxLength={254} value={form.email} onChange={(event) => setField("email", event.target.value)}
                    className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2.5 focus:border-emerald-500 focus:outline-none" />
                </label>
                <label className="sm:col-span-2">
                  <span className="text-sm font-bold text-slate-800">Address line 1</span>
                  <input maxLength={180} value={form.address_line1} onChange={(event) => setField("address_line1", event.target.value)}
                    className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2.5 focus:border-emerald-500 focus:outline-none" />
                </label>
                <label className="sm:col-span-2">
                  <span className="text-sm font-bold text-slate-800">Address line 2</span>
                  <input maxLength={180} value={form.address_line2} onChange={(event) => setField("address_line2", event.target.value)}
                    className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2.5 focus:border-emerald-500 focus:outline-none" />
                </label>
                <label>
                  <span className="text-sm font-bold text-slate-800">Town / city</span>
                  <input maxLength={100} value={form.town} onChange={(event) => setField("town", event.target.value)}
                    className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2.5 focus:border-emerald-500 focus:outline-none" />
                </label>
                <label>
                  <span className="text-sm font-bold text-slate-800">Postcode</span>
                  <input maxLength={20} value={form.postcode} onChange={(event) => setField("postcode", event.target.value)}
                    className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2.5 uppercase focus:border-emerald-500 focus:outline-none" />
                </label>
                <label className="sm:col-span-2">
                  <span className="text-sm font-bold text-slate-800">Customer notes</span>
                  <textarea rows={3} maxLength={3000} value={form.notes} onChange={(event) => setField("notes", event.target.value)}
                    placeholder="Gate access, special instructions, preferred contact times…"
                    className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2.5 focus:border-emerald-500 focus:outline-none" />
                </label>
              </div>
              {formError && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{formError}</p>}
              <div className="flex justify-end gap-3 border-t pt-4">
                <button type="button" disabled={saving} onClick={() => setEditorOpen(false)}
                  className="rounded-xl border border-slate-300 px-5 py-2.5 font-bold text-slate-700 disabled:opacity-50">Cancel</button>
                <button type="submit" disabled={saving} className="rounded-xl bg-emerald-600 px-5 py-2.5 font-bold text-white hover:bg-emerald-700 disabled:opacity-50">
                  {saving ? "Saving…" : editingId ? "Save changes" : "Add customer"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
