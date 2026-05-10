import { useEffect, useRef, useState } from "react";
import api from "@/lib/api";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { toast } from "sonner";
import { ArrowLeft, Plus, Pencil, Trash2, Paperclip, X, FileText } from "lucide-react";

export default function BlastTemplates() {
  const [items, setItems] = useState([]);
  const [editing, setEditing] = useState(null);
  const fileRef = useRef(null);
  const nav = useNavigate();

  const load = async () => {
    const r = await api.get("/blast-templates");
    setItems(r.data);
  };
  useEffect(() => { load(); }, []);

  const openNew = () => setEditing({ name: "", message: "", attachment_id: null, attachment_name: null });
  const openEdit = (t) => setEditing({ ...t });

  const handleAttach = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const fd = new FormData();
    fd.append("file", f);
    const r = await api.post("/broadcast/upload-attachment", fd);
    setEditing({ ...editing, attachment_id: r.data.file_id, attachment_name: r.data.filename });
    toast.success("Attachment uploaded");
  };

  const save = async () => {
    if (!editing.name?.trim()) return toast.error("Template name required");
    if (editing.id) {
      await api.put(`/blast-templates/${editing.id}`, editing);
    } else {
      await api.post("/blast-templates", editing);
    }
    setEditing(null);
    load();
    toast.success("Saved");
  };

  const remove = async (id) => {
    if (!window.confirm("Delete this template?")) return;
    await api.delete(`/blast-templates/${id}`);
    load();
    toast.success("Deleted");
  };

  return (
    <div className="space-y-4" data-testid="blast-templates-page">
      <div className="flex items-center gap-3 pt-2">
        <button onClick={() => nav(-1)} className="w-10 h-10 rounded-full bg-white border border-gray-200 flex items-center justify-center press-fx" data-testid="back-btn">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="flex-1">
          <h1 className="font-[Manrope] text-2xl font-bold tracking-tight text-gray-900">Blast Templates</h1>
          <p className="text-xs text-gray-500">{items.length} saved drafts</p>
        </div>
        <Button onClick={openNew} className="rounded-full h-10 bg-emerald-600 hover:bg-emerald-700 press-fx" data-testid="new-tpl-btn">
          <Plus className="w-4 h-4 mr-1" /> New
        </Button>
      </div>

      <div className="space-y-2" data-testid="tpl-list">
        {items.length === 0 && (
          <div className="bg-white rounded-2xl p-8 text-center text-sm text-gray-500 border border-dashed border-gray-300">
            No templates yet. Tap <strong>+ New</strong> to save your first one.
          </div>
        )}
        {items.map((t) => (
          <div key={t.id} className="bg-white border border-gray-200 rounded-2xl p-4" data-testid={`tpl-${t.id}`}>
            <div className="flex items-start justify-between gap-2 mb-2">
              <div className="flex-1 min-w-0">
                <h3 className="font-[Manrope] font-semibold text-base truncate">{t.name}</h3>
                {t.attachment_name && (
                  <span className="inline-flex items-center gap-1 mt-1 text-[11px] bg-amber-50 text-amber-700 px-2 py-0.5 rounded-full">
                    <FileText className="w-3 h-3" /> {t.attachment_name}
                  </span>
                )}
              </div>
              <div className="flex gap-1.5">
                <button onClick={() => openEdit(t)} className="w-9 h-9 rounded-full bg-blue-50 text-blue-600 flex items-center justify-center press-fx" data-testid={`edit-tpl-${t.id}`}>
                  <Pencil className="w-4 h-4" />
                </button>
                <button onClick={() => remove(t.id)} className="w-9 h-9 rounded-full bg-red-50 text-red-600 flex items-center justify-center press-fx" data-testid={`del-tpl-${t.id}`}>
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
            {t.message && (
              <div className="text-sm text-gray-700 whitespace-pre-wrap bg-gray-50 rounded-xl p-3 max-h-40 overflow-auto">
                {t.message}
              </div>
            )}
          </div>
        ))}
      </div>

      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-w-md rounded-3xl">
          <DialogHeader>
            <DialogTitle>{editing?.id ? "Edit template" : "New template"}</DialogTitle>
            <DialogDescription>Save a reusable message + attachment for future blasts</DialogDescription>
          </DialogHeader>
          {editing && (
            <div className="space-y-3">
              <div>
                <label className="text-xs font-semibold uppercase tracking-[0.15em] text-gray-500">Template name *</label>
                <Input
                  value={editing.name}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                  placeholder="e.g. Diwali Offer 2026"
                  className="mt-1 h-11 rounded-2xl bg-gray-50 border-gray-200"
                  data-testid="tpl-name-input"
                />
              </div>
              <div>
                <label className="text-xs font-semibold uppercase tracking-[0.15em] text-gray-500">Message</label>
                <Textarea
                  value={editing.message || ""}
                  onChange={(e) => setEditing({ ...editing, message: e.target.value })}
                  placeholder="Write the message you want to blast..."
                  className="mt-1 min-h-[120px] rounded-2xl bg-gray-50 border-gray-200"
                  data-testid="tpl-message-input"
                />
              </div>
              <div>
                <label className="text-xs font-semibold uppercase tracking-[0.15em] text-gray-500 block mb-1">Attachment (optional)</label>
                <input ref={fileRef} type="file" hidden onChange={handleAttach} />
                <div className="flex items-center gap-2">
                  <Button type="button" variant="outline" onClick={() => fileRef.current?.click()} className="rounded-full h-10 border-gray-200 press-fx" data-testid="tpl-attach-btn">
                    <Paperclip className="w-4 h-4 mr-1" /> {editing.attachment_id ? "Replace" : "Add"}
                  </Button>
                  {editing.attachment_id && (
                    <span className="inline-flex items-center gap-1 bg-emerald-50 text-emerald-700 text-xs px-3 py-1.5 rounded-full" data-testid="tpl-attach-chip">
                      {editing.attachment_name}
                      <button onClick={() => setEditing({ ...editing, attachment_id: null, attachment_name: null })}>
                        <X className="w-3 h-3" />
                      </button>
                    </span>
                  )}
                </div>
              </div>
              <Button onClick={save} className="w-full h-12 rounded-full bg-emerald-600 hover:bg-emerald-700 press-fx" data-testid="tpl-save-btn">
                Save Template
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
