import { useEffect, useState } from "react";
import api from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { toast } from "sonner";
import { RotateCcw, Pencil } from "lucide-react";

const PLACEHOLDERS = ["{firm}", "{city}", "{state}", "{prefix}", "{range}", "{brand}", "{series}", "{range_list}", "{brand_list}", "{series_list}"];

export default function BotMessages() {
  const [templates, setTemplates] = useState([]);
  const [editing, setEditing] = useState(null);
  const [text, setText] = useState("");

  const load = async () => {
    const r = await api.get("/templates");
    setTemplates(r.data);
  };
  useEffect(() => { load(); }, []);

  const save = async () => {
    await api.put(`/templates/${editing.id}`, { text });
    toast.success("Template saved");
    setEditing(null);
    load();
  };

  const reset = async (id) => {
    await api.post(`/templates/reset/${id}`);
    toast.success("Reset to default");
    load();
  };

  const insert = (ph) => {
    setText((t) => t + ph);
  };

  return (
    <div className="space-y-4" data-testid="bot-messages-page">
      <div className="pt-2">
        <h1 className="font-[Manrope] text-3xl font-bold tracking-tight text-gray-900">Bot Messages</h1>
        <p className="text-sm text-gray-500">Customize what the bot replies</p>
      </div>

      <div className="space-y-2">
        {templates.map((t) => (
          <div key={t.id} className="bg-white border border-gray-200 rounded-2xl p-4" data-testid={`tpl-${t.id}`}>
            <div className="flex items-start justify-between gap-2 mb-2">
              <h3 className="font-[Manrope] font-semibold text-sm">{t.name}</h3>
              <div className="flex gap-1">
                <button onClick={() => reset(t.id)} className="w-9 h-9 rounded-full bg-gray-100 flex items-center justify-center press-fx" data-testid={`reset-${t.id}`}>
                  <RotateCcw className="w-4 h-4 text-gray-600" />
                </button>
                <button onClick={() => { setEditing(t); setText(t.text); }} className="w-9 h-9 rounded-full bg-emerald-600 text-white flex items-center justify-center press-fx" data-testid={`edit-${t.id}`}>
                  <Pencil className="w-4 h-4" />
                </button>
              </div>
            </div>
            <div className="text-sm text-gray-600 whitespace-pre-wrap font-mono leading-relaxed bg-gray-50 rounded-xl p-3">{t.text}</div>
          </div>
        ))}
      </div>

      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-w-md rounded-3xl">
          <DialogHeader>
            <DialogTitle>{editing?.name}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Textarea value={text} onChange={(e) => setText(e.target.value)} className="min-h-[180px] rounded-2xl bg-gray-50 border-gray-200 font-mono text-sm" data-testid="tpl-edit-textarea" />
            <div className="flex flex-wrap gap-1.5">
              {PLACEHOLDERS.map((p) => (
                <button key={p} onClick={() => insert(p)} className="text-[11px] bg-emerald-50 text-emerald-700 px-2 py-1 rounded-full hover:bg-emerald-100">{p}</button>
              ))}
            </div>
            {/* Preview */}
            <div className="wa-doodle-bg rounded-2xl p-4">
              <div className="bubble-in p-3 max-w-[85%] shadow-sm">
                <div className="text-sm whitespace-pre-wrap">{text || "Preview"}</div>
              </div>
            </div>
            <Button onClick={save} className="w-full h-12 rounded-full bg-emerald-600 hover:bg-emerald-700 press-fx" data-testid="tpl-save-btn">Save</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
