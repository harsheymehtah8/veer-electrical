import { useEffect, useRef, useState } from "react";
import api, { API_BASE } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ArrowLeft, Send, RotateCcw, FileText } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

export default function Simulator() {
  const nav = useNavigate();
  const [phone, setPhone] = useState("9999900001");
  const [msg, setMsg] = useState("");
  const [chat, setChat] = useState([]);
  const scrollRef = useRef(null);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [chat]);

  const send = async () => {
    if (!msg.trim()) return;
    const text = msg;
    setMsg("");
    setChat((c) => [...c, { from: "customer", text }]);
    try {
      const r = await api.post("/bot/incoming", { phone, message: text });
      const replies = r.data.replies || [];
      if (replies.length === 0) {
        setChat((c) => [...c, { from: "system", text: "(bot is silent — returning customer needs to type 'send pdf')" }]);
      } else {
        for (const rep of replies) {
          setChat((c) => [...c, { from: "bot", ...rep }]);
        }
      }
    } catch {
      toast.error("Bot error");
    }
  };

  const reset = async () => {
    await api.post(`/bot/reset/${phone}`);
    setChat([]);
    toast.success("Customer reset");
  };

  return (
    <div className="-mx-4 min-h-[calc(100vh-9rem)] flex flex-col" data-testid="simulator-page">
      {/* Header */}
      <div className="bg-emerald-600 text-white px-3 py-3 flex items-center gap-3 sticky top-0 z-10">
        <button onClick={() => nav(-1)} className="press-fx" data-testid="sim-back"><ArrowLeft className="w-5 h-5" /></button>
        <div className="flex-1">
          <div className="font-[Manrope] font-semibold text-sm">Bot Tester</div>
          <Input
            value={phone}
            onChange={(e) => { setPhone(e.target.value.replace(/\D/g, "")); setChat([]); }}
            className="h-7 mt-0.5 px-2 text-xs rounded-md bg-emerald-700 border-emerald-500 text-white placeholder:text-emerald-100"
            data-testid="sim-phone"
          />
        </div>
        <button onClick={reset} className="press-fx" title="Reset" data-testid="sim-reset"><RotateCcw className="w-5 h-5" /></button>
      </div>

      {/* Chat */}
      <div ref={scrollRef} className="wa-doodle-bg flex-1 overflow-y-auto p-3 space-y-2" data-testid="sim-chat">
        {chat.length === 0 && (
          <div className="text-center text-xs text-gray-700 bg-yellow-100/80 rounded-full px-3 py-1.5 mx-auto w-fit">
            Pretend you're a customer. Type anything.
          </div>
        )}
        {chat.map((m, i) => {
          if (m.from === "system") {
            return <div key={i} className="text-center text-[11px] text-gray-700 bg-white/70 rounded-full px-3 py-1 mx-auto w-fit">{m.text}</div>;
          }
          if (m.from === "customer") {
            return (
              <div key={i} className="flex justify-end">
                <div className="bubble-out px-3 py-2 max-w-[80%] shadow-sm">
                  <div className="text-sm whitespace-pre-wrap">{m.text}</div>
                </div>
              </div>
            );
          }
          // bot
          return (
            <div key={i} className="flex justify-start">
              <div className="bubble-in px-3 py-2 max-w-[80%] shadow-sm">
                {m.type === "pdf" ? (
                  <a href={`${API_BASE}/files/${m.file_id}`} target="_blank" rel="noreferrer" className="flex items-center gap-2 text-emerald-700">
                    <FileText className="w-5 h-5" />
                    <span className="text-sm font-medium">{m.filename}</span>
                  </a>
                ) : (
                  <div className="text-sm whitespace-pre-wrap">{m.text}</div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Composer */}
      <div className="bg-white border-t border-gray-200 p-2 flex items-center gap-2 sticky bottom-16">
        <Input
          value={msg}
          onChange={(e) => setMsg(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder="Type a customer message..."
          className="h-11 rounded-full bg-gray-50 border-gray-200"
          data-testid="sim-input"
        />
        <Button onClick={send} className="rounded-full h-11 w-11 p-0 bg-emerald-600 hover:bg-emerald-700 press-fx" data-testid="sim-send">
          <Send className="w-5 h-5" />
        </Button>
      </div>
    </div>
  );
}
