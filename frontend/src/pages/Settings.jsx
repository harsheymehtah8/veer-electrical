import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import api from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { LogOut, Send, Radio, Bot } from "lucide-react";

export default function Settings() {
  const [s, setS] = useState({ business_name: "", prefix_tag: "", owner_phone: "" });
  const nav = useNavigate();

  useEffect(() => {
    api.get("/settings").then((r) => setS(r.data));
  }, []);

  const save = async () => {
    await api.put("/settings", s);
    toast.success("Saved");
  };

  const logout = () => {
    localStorage.removeItem("ve_token");
    localStorage.removeItem("ve_phone");
    nav("/login");
  };

  return (
    <div className="space-y-4" data-testid="settings-page">
      <div className="pt-2">
        <h1 className="font-[Manrope] text-3xl font-bold tracking-tight text-gray-900">More</h1>
        <p className="text-sm text-gray-500">Settings, senders &amp; bot tester</p>
      </div>

      {/* Quick links */}
      <div className="grid grid-cols-3 gap-2">
        <button onClick={() => nav("/senders")} className="bg-white border border-gray-200 rounded-2xl p-3 text-left press-fx" data-testid="quick-senders">
          <Radio className="w-5 h-5 text-emerald-600 mb-2" />
          <div className="text-xs font-semibold">Senders</div>
        </button>
        <button onClick={() => nav("/bot")} className="bg-white border border-gray-200 rounded-2xl p-3 text-left press-fx" data-testid="quick-bot">
          <Bot className="w-5 h-5 text-emerald-600 mb-2" />
          <div className="text-xs font-semibold">Bot Messages</div>
        </button>
        <button onClick={() => nav("/simulator")} className="bg-white border border-gray-200 rounded-2xl p-3 text-left press-fx" data-testid="quick-simulator">
          <Send className="w-5 h-5 text-emerald-600 mb-2" />
          <div className="text-xs font-semibold">Test Bot</div>
        </button>
      </div>

      <div className="bg-white rounded-3xl border border-gray-200 p-4 space-y-3">
        <h2 className="font-[Manrope] text-base font-semibold">Business</h2>
        <div>
          <label className="text-xs font-semibold uppercase tracking-[0.2em] text-gray-500">Business name</label>
          <Input value={s.business_name} onChange={(e) => setS({ ...s, business_name: e.target.value })} className="mt-1 h-12 rounded-2xl bg-gray-50 border-gray-200" data-testid="settings-business-name" />
        </div>
        <div>
          <label className="text-xs font-semibold uppercase tracking-[0.2em] text-gray-500">2-letter contact prefix tag</label>
          <Input
            value={s.prefix_tag}
            onChange={(e) => setS({ ...s, prefix_tag: e.target.value.toUpperCase().slice(0, 4) })}
            className="mt-1 h-12 rounded-2xl bg-gray-50 border-gray-200 uppercase tracking-widest"
            data-testid="settings-prefix-tag"
            maxLength={4}
          />
          <p className="text-[11px] text-gray-400 mt-1">Saved contacts: <span className="font-mono">{s.prefix_tag} Veer Traders - Surat</span></p>
        </div>
        <div>
          <label className="text-xs font-semibold uppercase tracking-[0.2em] text-gray-500">Owner phone</label>
          <Input value={s.owner_phone || ""} onChange={(e) => setS({ ...s, owner_phone: e.target.value })} className="mt-1 h-12 rounded-2xl bg-gray-50 border-gray-200" data-testid="settings-owner-phone" />
        </div>
        <Button onClick={save} className="w-full h-12 rounded-full bg-emerald-600 hover:bg-emerald-700 press-fx" data-testid="settings-save-btn">Save</Button>
      </div>

      <Button onClick={logout} variant="outline" className="w-full h-12 rounded-full border-red-200 text-red-600 hover:bg-red-50 press-fx" data-testid="logout-btn">
        <LogOut className="w-4 h-4 mr-2" /> Logout
      </Button>
    </div>
  );
}
