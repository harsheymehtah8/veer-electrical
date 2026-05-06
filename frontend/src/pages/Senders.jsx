import { useEffect, useState } from "react";
import api from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "sonner";
import { Plus, Trash2, QrCode, CheckCircle2 } from "lucide-react";

export default function Senders() {
  const [senders, setSenders] = useState([]);
  const [newLabel, setNewLabel] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [scanning, setScanning] = useState(null);

  const load = async () => {
    const r = await api.get("/senders");
    setSenders(r.data);
  };
  useEffect(() => { load(); }, []);

  const add = async () => {
    if (!newLabel.trim()) return;
    await api.post("/senders", { label: newLabel.trim(), phone: newPhone.trim() });
    setNewLabel(""); setNewPhone("");
    load();
  };
  const del = async (id) => {
    if (!window.confirm("Disconnect & remove sender?")) return;
    await api.delete(`/senders/${id}`);
    load();
  };
  const connect = async (id) => {
    setScanning(id);
    await new Promise((r) => setTimeout(r, 1800));
    await api.post(`/senders/${id}/connect`);
    setScanning(null);
    toast.success("Connected (simulated)");
    load();
  };

  const dot = (s) => ({
    Healthy: "bg-emerald-500",
    Caution: "bg-amber-500",
    Risk: "bg-red-500",
    Disconnected: "bg-gray-400",
  })[s] || "bg-gray-400";

  return (
    <div className="space-y-4" data-testid="senders-page">
      <div className="pt-2">
        <h1 className="font-[Manrope] text-3xl font-bold tracking-tight text-gray-900">Senders</h1>
        <p className="text-sm text-gray-500">WhatsApp sender numbers (simulated)</p>
      </div>

      <div className="bg-white rounded-3xl border border-gray-200 p-3 space-y-2">
        <Input value={newLabel} onChange={(e) => setNewLabel(e.target.value)} placeholder="Label (e.g. Sender 3 - Vi)" className="h-11 rounded-full bg-gray-50 border-gray-200 px-4" data-testid="new-sender-label" />
        <div className="flex gap-2">
          <Input value={newPhone} onChange={(e) => setNewPhone(e.target.value.replace(/\D/g, ""))} placeholder="Phone (optional)" className="h-11 rounded-full bg-gray-50 border-gray-200 px-4" data-testid="new-sender-phone" />
          <Button onClick={add} className="rounded-full h-11 bg-emerald-600 hover:bg-emerald-700 press-fx" data-testid="add-sender-btn"><Plus className="w-4 h-4" /></Button>
        </div>
      </div>

      <div className="space-y-2">
        {senders.map((s) => (
          <div key={s.id} className="bg-white border border-gray-200 rounded-2xl p-3 flex items-center gap-3" data-testid={`sender-${s.id}`}>
            <div className="w-11 h-11 rounded-full bg-gray-100 flex items-center justify-center">
              <span className={`w-3 h-3 rounded-full ${dot(s.status)}`} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="font-[Manrope] font-semibold text-sm truncate">{s.label}</div>
              <div className="text-xs text-gray-500 truncate">
                {s.phone || "Not linked"} • {s.daily_sent}/{s.daily_cap} today • {s.status}
              </div>
            </div>
            {s.status === "Disconnected" || !s.phone ? (
              <Button onClick={() => connect(s.id)} className="rounded-full h-9 bg-emerald-600 hover:bg-emerald-700 text-xs press-fx" data-testid={`connect-${s.id}`}>
                <QrCode className="w-3.5 h-3.5 mr-1" /> Connect
              </Button>
            ) : (
              <span className="inline-flex items-center gap-1 text-[11px] bg-emerald-50 text-emerald-700 px-2 py-1 rounded-full">
                <CheckCircle2 className="w-3 h-3" /> Linked
              </span>
            )}
            <button onClick={() => del(s.id)} className="text-red-500 ml-1" data-testid={`del-sender-${s.id}`}>
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        ))}
        {senders.length === 0 && <p className="text-center text-sm text-gray-500 py-8">No senders yet</p>}
      </div>

      <Dialog open={!!scanning} onOpenChange={() => {}}>
        <DialogContent className="max-w-xs rounded-3xl text-center">
          <DialogHeader>
            <DialogTitle>Scan QR (simulated)</DialogTitle>
          </DialogHeader>
          <div className="py-6 flex flex-col items-center">
            <div className="w-40 h-40 grid grid-cols-8 grid-rows-8 gap-0.5 bg-white p-2 border-2 border-gray-300 rounded-xl">
              {Array.from({ length: 64 }).map((_, i) => (
                <div key={i} className={`${Math.random() > 0.5 ? "bg-gray-900" : "bg-white"}`} />
              ))}
            </div>
            <p className="text-xs text-gray-500 mt-3">Connecting... (~2s)</p>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
