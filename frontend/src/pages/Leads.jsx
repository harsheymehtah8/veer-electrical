import { useEffect, useState } from "react";
import api, { API_BASE } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { Search, Download, MessageSquare, Phone, Trash2 } from "lucide-react";
import { useNavigate } from "react-router-dom";

export default function Leads() {
  const [leads, setLeads] = useState([]);
  const [q, setQ] = useState("");
  const nav = useNavigate();

  const load = async () => {
    const r = await api.get("/leads", { params: { q: q || undefined } });
    setLeads(r.data);
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [q]);

  const exportXlsx = async () => {
    const url = `${API_BASE}/leads/export`;
    const tok = localStorage.getItem("ve_token");
    const res = await fetch(url, { headers: tok ? { Authorization: `Bearer ${tok}` } : {} });
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "leads.xlsx";
    a.click();
    toast.success("Exported");
  };

  const remove = async (id) => {
    if (!window.confirm("Delete this lead?")) return;
    await api.delete(`/leads/${id}`);
    load();
  };

  const status = (l) => {
    if (l.pdf_pending) return { label: "PDF pending", c: "bg-amber-50 text-amber-700" };
    if (l.status === "pricelist_sent") return { label: "Pricelist sent", c: "bg-emerald-50 text-emerald-700" };
    return { label: "New", c: "bg-blue-50 text-blue-700" };
  };

  return (
    <div className="space-y-4" data-testid="leads-page">
      <div className="flex items-end justify-between pt-2">
        <div>
          <h1 className="font-[Manrope] text-3xl font-bold tracking-tight text-gray-900">Leads</h1>
          <p className="text-sm text-gray-500">{leads.length} total</p>
        </div>
        <Button onClick={() => nav("/simulator")} variant="outline" className="rounded-full h-10 border-emerald-600 text-emerald-700 press-fx" data-testid="open-simulator-btn">
          Test bot
        </Button>
      </div>

      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search firm / city / phone" className="pl-9 h-12 rounded-full bg-white border-gray-200" data-testid="leads-search" />
        </div>
        <Button onClick={exportXlsx} variant="outline" className="rounded-full h-12 border-gray-200 press-fx" data-testid="export-leads-btn">
          <Download className="w-4 h-4" />
        </Button>
      </div>

      <div className="space-y-2" data-testid="leads-list">
        {leads.length === 0 && (
          <div className="text-center py-12 text-gray-500 text-sm">No leads yet. They'll show here when customers reply.</div>
        )}
        {leads.map((l) => {
          const st = status(l);
          return (
            <div key={l.id} className="bg-white border border-gray-200 rounded-2xl p-3 flex items-center gap-3" data-testid={`lead-${l.id}`}>
              <div className="w-12 h-12 rounded-full bg-emerald-600 text-white flex items-center justify-center font-[Manrope] font-bold text-sm shrink-0">
                {l.prefix_tag}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="font-semibold text-sm truncate">{l.party_name}</h3>
                  <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${st.c}`}>{st.label}</span>
                </div>
                <div className="text-xs text-gray-500 truncate">
                  {l.city}, {l.state} • {l.phone}
                </div>
                {l.interested_brand && (
                  <div className="text-[11px] text-gray-400 truncate">
                    {l.interested_range} → {l.interested_brand} → {l.interested_series}
                  </div>
                )}
              </div>
              <div className="flex flex-col gap-1.5">
                <a href={`tel:${l.phone}`} className="w-9 h-9 rounded-full bg-emerald-50 text-emerald-700 flex items-center justify-center press-fx" data-testid={`lead-call-${l.id}`}>
                  <Phone className="w-4 h-4" />
                </a>
                <button onClick={() => remove(l.id)} className="w-9 h-9 rounded-full bg-red-50 text-red-600 flex items-center justify-center press-fx" data-testid={`lead-del-${l.id}`}>
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
