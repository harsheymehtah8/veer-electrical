import { useEffect, useRef, useState } from "react";
import api, { API_BASE } from "@/lib/api";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { Search, Download, Upload, Plus, Phone, Trash2, Pencil, Filter, Users } from "lucide-react";

const SOURCE_LABEL = { manual: "Manual", imported: "Imported", bot: "Bot Lead" };
const SOURCE_COLOR = {
  manual: "bg-blue-50 text-blue-700",
  imported: "bg-violet-50 text-violet-700",
  bot: "bg-emerald-50 text-emerald-700",
};

export default function Contacts() {
  const [contacts, setContacts] = useState([]);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState("");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [stats, setStats] = useState({ total: 0, by_source: {} });

  // Add/Edit dialog
  const [editing, setEditing] = useState(null);

  // Bulk-delete dialog state
  const [bulkOpen, setBulkOpen] = useState(false);
  const [batches, setBatches] = useState([]); // [{name, count}]
  const [bulkFilter, setBulkFilter] = useState({ import_batch: "", state: "", city: "", source: "" });
  const [bulkPreview, setBulkPreview] = useState(null); // {count, samples}
  const [bulkBusy, setBulkBusy] = useState(false);

  const nav = useNavigate();

  // Import wizard
  const [importStep, setImportStep] = useState(0); // 0=closed, 1=preview, 2=mapping
  const [importData, setImportData] = useState(null);
  const [mapping, setMapping] = useState({});
  const importFileRef = useRef(null);

  const load = async () => {
    const params = { q: q || undefined, source: sourceFilter === "all" ? undefined : sourceFilter, limit: 500 };
    const [r, s] = await Promise.all([
      api.get("/contacts", { params }),
      api.get("/contacts/stats"),
    ]);
    setContacts(r.data.items);
    setTotal(r.data.total);
    setStats(s.data);
  };

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line
  }, [q, sourceFilter]);

  const handleImportFile = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const fd = new FormData();
    fd.append("file", f);
    try {
      const r = await api.post("/contacts/import/preview", fd);
      setImportData(r.data);
      setMapping({});
      setImportStep(2);
    } catch {
      toast.error("Failed to read file");
    }
  };

  const commitImport = async () => {
    if (!mapping.mobile) {
      toast.error("Mobile column is required");
      return;
    }
    try {
      const r = await api.post("/contacts/import/commit", {
        file_id: importData.file_id,
        mapping,
      });
      toast.success(`${r.data.inserted} new, ${r.data.merged} updated, ${r.data.skipped} skipped`);
      setImportStep(0);
      setImportData(null);
      load();
    } catch {
      toast.error("Import failed");
    }
  };

  const exportXlsx = async () => {
    const tok = localStorage.getItem("ve_token");
    const res = await fetch(`${API_BASE}/contacts/export`, { headers: tok ? { Authorization: `Bearer ${tok}` } : {} });
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "contacts.xlsx";
    a.click();
    toast.success("Exported");
  };

  const remove = async (id) => {
    if (!window.confirm("Delete this contact?")) return;
    await api.delete(`/contacts/${id}`);
    load();
  };

  // ---- Bulk delete ----
  const openBulkDialog = async () => {
    setBulkFilter({ import_batch: "", state: "", city: "", source: "" });
    setBulkPreview(null);
    setBulkOpen(true);
    try {
      const r = await api.get("/contacts/import-batches");
      setBatches(r.data || []);
    } catch {
      setBatches([]);
    }
  };

  const hasBulkFilter = !!(bulkFilter.import_batch || bulkFilter.state || bulkFilter.city || bulkFilter.source);

  const runBulkPreview = async () => {
    if (!hasBulkFilter) return toast.error("Pick at least one filter");
    setBulkBusy(true);
    try {
      const body = {};
      for (const k of ["import_batch", "state", "city", "source"]) {
        if (bulkFilter[k]) body[k] = bulkFilter[k];
      }
      const r = await api.post("/contacts/bulk-delete/preview", body);
      setBulkPreview(r.data);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Preview failed");
    } finally {
      setBulkBusy(false);
    }
  };

  const confirmBulkDelete = async () => {
    if (!bulkPreview || !bulkPreview.count) return;
    if (!window.confirm(`Delete ${bulkPreview.count.toLocaleString()} contacts? This cannot be undone.`)) return;
    setBulkBusy(true);
    try {
      const body = { confirm: true };
      for (const k of ["import_batch", "state", "city", "source"]) {
        if (bulkFilter[k]) body[k] = bulkFilter[k];
      }
      const r = await api.post("/contacts/bulk-delete/commit", body);
      toast.success(`Deleted ${r.data.deleted.toLocaleString()} contacts`);
      setBulkOpen(false);
      load();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Delete failed");
    } finally {
      setBulkBusy(false);
    }
  };

  const saveContact = async () => {
    if (!editing.mobile?.trim()) return toast.error("Mobile required");
    if (editing.id) {
      await api.put(`/contacts/${editing.id}`, editing);
    } else {
      await api.post("/contacts", editing);
    }
    setEditing(null);
    load();
    toast.success("Saved");
  };

  const FIELDS = [
    { key: "name", label: "Name" },
    { key: "shop_name", label: "Shop name" },
    { key: "mobile", label: "Mobile *", required: true },
    { key: "city", label: "City" },
    { key: "district", label: "District" },
    { key: "state", label: "State" },
  ];

  return (
    <div className="space-y-4" data-testid="contacts-page">
      <div className="flex items-end justify-between pt-2">
        <div>
          <h1 className="font-[Manrope] text-3xl font-bold tracking-tight text-gray-900">Contacts</h1>
          <p className="text-sm text-gray-500">{stats.total} total — Bot: {stats.by_source.bot || 0} · Imported: {stats.by_source.imported || 0} · Manual: {stats.by_source.manual || 0}</p>
        </div>
        <button onClick={() => nav("/groups")} className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200 press-fx" data-testid="open-groups-btn">
          <Users className="w-3.5 h-3.5" /> Groups
        </button>
      </div>

      {/* Action row */}
      <div className="flex items-center gap-2">
        <input ref={importFileRef} type="file" hidden accept=".xlsx,.xls,.csv" onChange={handleImportFile} />
        <Button onClick={() => importFileRef.current?.click()} className="rounded-full h-11 bg-emerald-600 hover:bg-emerald-700 press-fx flex-1" data-testid="import-btn">
          <Upload className="w-4 h-4 mr-1.5" /> Import Excel/CSV
        </Button>
        <Button onClick={() => setEditing({ name: "", shop_name: "", mobile: "", city: "", district: "", state: "" })} variant="outline" className="rounded-full h-11 border-emerald-200 text-emerald-700 press-fx" data-testid="add-btn">
          <Plus className="w-4 h-4" />
        </Button>
        <Button onClick={exportXlsx} variant="outline" className="rounded-full h-11 border-gray-200 press-fx" data-testid="export-btn">
          <Download className="w-4 h-4" />
        </Button>
        <Button onClick={openBulkDialog} variant="outline" className="rounded-full h-11 border-red-200 text-red-600 hover:bg-red-50 press-fx" data-testid="bulk-delete-btn">
          <Trash2 className="w-4 h-4" />
        </Button>
      </div>

      {/* Search + filter */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name / shop / city / mobile" className="pl-9 h-12 rounded-full bg-white border-gray-200" data-testid="contacts-search" />
        </div>
        <Select value={sourceFilter} onValueChange={setSourceFilter}>
          <SelectTrigger className="w-32 rounded-full h-12 bg-white border-gray-200" data-testid="source-filter">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="manual">Manual</SelectItem>
            <SelectItem value="imported">Imported</SelectItem>
            <SelectItem value="bot">Bot Lead</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <p className="text-xs text-gray-400" data-testid="contacts-match-count">
        {total.toLocaleString()} matching • showing first {Math.min(contacts.length, total).toLocaleString()}
      </p>

      {/* List */}
      <div className="space-y-2" data-testid="contacts-list">
        {contacts.length === 0 && (
          <div className="text-center py-12 text-gray-500 text-sm">No contacts. Tap "Import Excel" or "+" to add.</div>
        )}
        {contacts.map((c) => (
          <div key={c.id} className="bg-white border border-gray-200 rounded-2xl p-3 flex items-center gap-3" data-testid={`contact-${c.id}`}>
            <div className="w-12 h-12 rounded-full bg-emerald-600 text-white flex items-center justify-center font-[Manrope] font-bold text-sm shrink-0">
              {(c.name || c.shop_name || c.mobile || "?").trim().slice(0, 2).toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="font-semibold text-sm truncate">{c.name || c.shop_name || "Unnamed"}</h3>
                <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${SOURCE_COLOR[c.source] || ""}`}>
                  {SOURCE_LABEL[c.source] || c.source}
                </span>
              </div>
              {c.shop_name && c.name && <div className="text-xs text-gray-700 truncate font-medium">{c.shop_name}</div>}
              <div className="text-xs text-gray-500 truncate">+{c.mobile} {c.city ? `• ${c.city}` : ""} {c.state ? `• ${c.state}` : ""}</div>
              {c.import_batch && (
                <div className="text-[10px] text-violet-600 truncate mt-0.5" data-testid={`contact-batch-${c.id}`}>
                  📄 {c.import_batch}
                </div>
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <a href={`tel:+${c.mobile}`} className="w-9 h-9 rounded-full bg-emerald-50 text-emerald-700 flex items-center justify-center press-fx" data-testid={`contact-call-${c.id}`}>
                <Phone className="w-4 h-4" />
              </a>
              <button onClick={() => setEditing({ ...c })} className="w-9 h-9 rounded-full bg-blue-50 text-blue-600 flex items-center justify-center press-fx" data-testid={`contact-edit-${c.id}`}>
                <Pencil className="w-4 h-4" />
              </button>
              <button onClick={() => remove(c.id)} className="w-9 h-9 rounded-full bg-red-50 text-red-600 flex items-center justify-center press-fx" data-testid={`contact-del-${c.id}`}>
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          </div>
        ))}
        {total > contacts.length && (
          <div className="text-center text-xs text-amber-600 pt-3 pb-1" data-testid="contacts-truncated-hint">
            ⚠ {(total - contacts.length).toLocaleString()} more match — use search to find specific contacts.
          </div>
        )}
      </div>

      {/* Add/Edit Dialog */}
      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-w-md rounded-3xl">
          <DialogHeader>
            <DialogTitle>{editing?.id ? "Edit contact" : "New contact"}</DialogTitle>
            <DialogDescription>Indian numbers auto-prefixed with +91</DialogDescription>
          </DialogHeader>
          {editing && (
            <div className="space-y-3">
              {FIELDS.map((f) => (
                <div key={f.key}>
                  <label className="text-xs font-semibold uppercase tracking-[0.15em] text-gray-500">{f.label}</label>
                  <Input
                    value={editing[f.key] || ""}
                    onChange={(e) => setEditing({ ...editing, [f.key]: e.target.value })}
                    className="mt-1 h-11 rounded-2xl bg-gray-50 border-gray-200"
                    data-testid={`edit-${f.key}`}
                    inputMode={f.key === "mobile" ? "numeric" : "text"}
                  />
                </div>
              ))}
              <Button onClick={saveContact} className="w-full h-12 rounded-full bg-emerald-600 hover:bg-emerald-700 press-fx" data-testid="save-contact-btn">
                Save
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Import Wizard Dialog */}
      <Dialog open={importStep === 2} onOpenChange={(o) => !o && setImportStep(0)}>
        <DialogContent className="max-w-md rounded-3xl">
          <DialogHeader>
            <DialogTitle>Map columns</DialogTitle>
            <DialogDescription>Tell us which column in your file is which field</DialogDescription>
          </DialogHeader>
          {importData && (
            <div className="space-y-3">
              <div className="text-xs text-gray-500">{importData.total_rows} rows ready to import</div>
              {FIELDS.map((f) => (
                <div key={f.key} className="flex items-center gap-2">
                  <label className="text-xs font-semibold uppercase tracking-wide text-gray-600 w-24 shrink-0">{f.label}</label>
                  <Select value={mapping[f.key] || "_none"} onValueChange={(v) => setMapping({ ...mapping, [f.key]: v === "_none" ? "" : v })}>
                    <SelectTrigger className="rounded-2xl flex-1 h-10" data-testid={`map-${f.key}`}>
                      <SelectValue placeholder="Select column..." />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="_none">— skip —</SelectItem>
                      {importData.columns.map((c) => (
                        <SelectItem key={c} value={c}>{c}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
              {importData.sample.length > 0 && (
                <div className="bg-gray-50 rounded-xl p-2 text-[10px] font-mono text-gray-600 max-h-32 overflow-auto">
                  <div className="font-semibold text-gray-700 mb-1">Preview (first row):</div>
                  {Object.entries(importData.sample[0]).slice(0, 6).map(([k, v]) => (
                    <div key={k}>{k}: <span className="text-gray-900">{String(v).slice(0, 40)}</span></div>
                  ))}
                </div>
              )}
              <Button onClick={commitImport} className="w-full h-12 rounded-full bg-emerald-600 hover:bg-emerald-700 press-fx" data-testid="commit-import-btn">
                Import {importData.total_rows} contacts
              </Button>
              <Button onClick={() => setImportStep(0)} variant="ghost" className="w-full h-10 rounded-full">
                Cancel
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* ===== Bulk Delete Dialog ===== */}
      <Dialog open={bulkOpen} onOpenChange={setBulkOpen}>
        <DialogContent className="max-w-md rounded-3xl">
          <DialogHeader>
            <DialogTitle>Bulk delete contacts</DialogTitle>
            <DialogDescription>
              Pick any combination of filters. You'll see a preview count before anything is deleted.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {/* Import batch */}
            <div>
              <label className="text-xs font-semibold uppercase tracking-[0.15em] text-gray-500">By uploaded file</label>
              <Select
                value={bulkFilter.import_batch || "none"}
                onValueChange={(v) => {
                  setBulkFilter({ ...bulkFilter, import_batch: v === "none" ? "" : v });
                  setBulkPreview(null);
                }}
              >
                <SelectTrigger className="mt-1 h-11 rounded-2xl bg-gray-50 border-gray-200" data-testid="bulk-batch-select">
                  <SelectValue placeholder="Select an imported file..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">— Any —</SelectItem>
                  {batches.map((b) => (
                    <SelectItem key={b.name} value={b.name}>
                      {b.name} ({b.count.toLocaleString()})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {batches.length === 0 && (
                <p className="text-[10px] text-gray-400 mt-1">No imported files tracked yet. Re-import to tag new files.</p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-xs font-semibold uppercase tracking-[0.15em] text-gray-500">State</label>
                <Input
                  value={bulkFilter.state}
                  onChange={(e) => { setBulkFilter({ ...bulkFilter, state: e.target.value }); setBulkPreview(null); }}
                  placeholder="e.g. Telangana"
                  className="mt-1 h-11 rounded-2xl bg-gray-50 border-gray-200"
                  data-testid="bulk-state-input"
                />
              </div>
              <div>
                <label className="text-xs font-semibold uppercase tracking-[0.15em] text-gray-500">City</label>
                <Input
                  value={bulkFilter.city}
                  onChange={(e) => { setBulkFilter({ ...bulkFilter, city: e.target.value }); setBulkPreview(null); }}
                  placeholder="e.g. Mumbai"
                  className="mt-1 h-11 rounded-2xl bg-gray-50 border-gray-200"
                  data-testid="bulk-city-input"
                />
              </div>
            </div>

            <div>
              <label className="text-xs font-semibold uppercase tracking-[0.15em] text-gray-500">Source</label>
              <Select
                value={bulkFilter.source || "any"}
                onValueChange={(v) => {
                  setBulkFilter({ ...bulkFilter, source: v === "any" ? "" : v });
                  setBulkPreview(null);
                }}
              >
                <SelectTrigger className="mt-1 h-11 rounded-2xl bg-gray-50 border-gray-200" data-testid="bulk-source-select">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">Any source</SelectItem>
                  <SelectItem value="manual">Manual</SelectItem>
                  <SelectItem value="imported">Imported</SelectItem>
                  <SelectItem value="bot">Bot Lead</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Preview button + result */}
            <Button
              onClick={runBulkPreview}
              disabled={!hasBulkFilter || bulkBusy}
              className="w-full h-11 rounded-full bg-blue-600 hover:bg-blue-700 disabled:opacity-50"
              data-testid="bulk-preview-btn"
            >
              {bulkBusy ? "..." : "Preview matches"}
            </Button>

            {bulkPreview && (
              <div className="bg-red-50 border border-red-200 rounded-2xl p-3 space-y-2" data-testid="bulk-preview-result">
                <div className="flex items-baseline justify-between">
                  <span className="text-sm font-semibold text-red-700">{bulkPreview.count.toLocaleString()} contacts will be deleted</span>
                </div>
                {bulkPreview.samples.length > 0 && (
                  <div className="text-[11px] text-gray-700 space-y-0.5 max-h-32 overflow-auto">
                    <div className="font-medium text-gray-600">Sample (first 5):</div>
                    {bulkPreview.samples.map((s, i) => (
                      <div key={i}>
                        • {s.name || s.shop_name || "Unnamed"} — +{s.mobile} {s.city ? `(${s.city})` : ""}
                      </div>
                    ))}
                  </div>
                )}
                <Button
                  onClick={confirmBulkDelete}
                  disabled={bulkBusy || !bulkPreview.count}
                  className="w-full h-11 rounded-full bg-red-600 hover:bg-red-700 disabled:opacity-50"
                  data-testid="bulk-confirm-btn"
                >
                  <Trash2 className="w-4 h-4 mr-1" />
                  {bulkBusy ? "Deleting..." : `Delete ${bulkPreview.count.toLocaleString()} contacts permanently`}
                </Button>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
