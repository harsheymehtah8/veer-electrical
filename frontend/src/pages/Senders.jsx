import { useEffect, useState } from "react";
import api from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { Trash2, CheckCircle2, AlertCircle } from "lucide-react";

export default function Senders() {
  const [senders, setSenders] = useState([]);

  const load = async () => {
    const r = await api.get("/senders");
    setSenders(r.data);
  };
  useEffect(() => {
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, []);

  const del = async (id) => {
    if (!window.confirm("Remove this sender? You'll need to re-link the SIM if you want to re-add it.")) return;
    await api.delete(`/senders/${id}`);
    toast.success("Removed");
    load();
  };

  const isOnline = (s) => {
    if (!s.last_seen) return false;
    return (Date.now() - new Date(s.last_seen).getTime()) < 30000;
  };

  return (
    <div className="space-y-4" data-testid="senders-page">
      <div className="pt-2">
        <h1 className="font-[Manrope] text-3xl font-bold tracking-tight text-gray-900">Senders</h1>
        <p className="text-sm text-gray-500">{senders.length} WhatsApp number{senders.length === 1 ? "" : "s"} linked</p>
      </div>

      <div className="bg-emerald-50 border border-emerald-200 rounded-2xl p-4 text-sm">
        <div className="font-semibold text-emerald-800 mb-1">Add a new sender</div>
        <p className="text-emerald-700 text-xs leading-relaxed">
          To add another SIM: SSH into your VPS and run a second worker with a unique <span className="font-mono">SENDER_ID</span>.
          See worker README. New senders appear here automatically after QR scan.
        </p>
      </div>

      <div className="space-y-2">
        {senders.length === 0 && (
          <p className="text-center text-sm text-gray-500 py-8">No senders yet — start your worker on the VPS</p>
        )}
        {senders.map((s) => {
          const online = isOnline(s);
          return (
            <div key={s.id} className="bg-white border border-gray-200 rounded-2xl p-3 flex items-center gap-3" data-testid={`sender-${s.id}`}>
              <div className="w-12 h-12 rounded-full bg-emerald-100 flex items-center justify-center shrink-0">
                <span className={`w-3 h-3 rounded-full ${online ? "bg-emerald-500 animate-pulse" : "bg-gray-400"}`} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-[Manrope] font-semibold text-sm truncate">{s.label || s.id}</div>
                <div className="text-xs text-gray-500 truncate">
                  {s.phone ? `+${s.phone}` : "No number yet (scan QR)"} • <span className="font-mono">{s.id}</span>
                </div>
                <div className="text-[11px] text-gray-400">
                  {s.daily_sent || 0}/{s.daily_cap || 50} today • {online ? (
                    <span className="text-emerald-600">Online</span>
                  ) : (
                    <span className="text-amber-600">Offline</span>
                  )}
                </div>
              </div>
              {online ? (
                <span className="inline-flex items-center gap-1 text-[11px] bg-emerald-50 text-emerald-700 px-2 py-1 rounded-full">
                  <CheckCircle2 className="w-3 h-3" /> Linked
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-[11px] bg-amber-50 text-amber-700 px-2 py-1 rounded-full">
                  <AlertCircle className="w-3 h-3" /> Offline
                </span>
              )}
              <button onClick={() => del(s.id)} className="text-red-500 ml-1" data-testid={`del-sender-${s.id}`}>
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
