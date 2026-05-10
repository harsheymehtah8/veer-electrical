import { useEffect, useRef, useState } from "react";
import api, { API_BASE } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { Search, Download, Upload, Plus, Phone, Trash2, Pencil, Filter } from "lucide-react";

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

  // Import wizard
  const [importStep, setImportStep] = useState(0); // 0=closed, 1=preview, 2=mapping
  const [importData, setImportData] = useState(null);
  const [mapping, setMapping] = useState({});
  const importFileRef = useRef(null);

  const load = async () => {
    const params = { q: q || undefined, source: sourceFilter === "all" ? undefined : sourceFilter };
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

      <p className="text-xs text-gray-400">{total} matching</p>

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
              {c.shop_name && c.name && <div className="text-xs text-gray-600 truncate">{c.shop_name}</div>}
              <div className="text-xs text-gray-500 truncate">+{c.mobile} {c.city ? `• ${c.city}` : ""} {c.state ? `• ${c.state}` : ""}</div>
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
    </div>
  );
}
