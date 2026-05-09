import { useEffect, useRef, useState } from "react";
import api, { API_BASE } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Progress } from "@/components/ui/progress";
import { toast } from "sonner";
import { Upload, Clipboard, Users, Paperclip, Send, X, Pause } from "lucide-react";

export default function Broadcaster() {
  const [contacts, setContacts] = useState([]);
  const [tab, setTab] = useState("excel");
  const [pasteText, setPasteText] = useState("");
  const [message, setMessage] = useState("");
  const [mode, setMode] = useState("A");
  const [attachment, setAttachment] = useState(null);
  const [job, setJob] = useState(null);
  const [savedLeads, setSavedLeads] = useState([]);
  const [pickerSel, setPickerSel] = useState({});
  const [senders, setSenders] = useState([]);
  const [pickedSender, setPickedSender] = useState("auto");
  const fileInput = useRef(null);
  const attachInput = useRef(null);
  const pollRef = useRef(null);

  useEffect(() => {
    if (tab === "leads") api.get("/leads").then((r) => setSavedLeads(r.data));
  }, [tab]);

  useEffect(() => {
    const loadSenders = () => api.get("/senders").then((r) => setSenders(r.data)).catch(() => {});
    loadSenders();
    const id = setInterval(loadSenders, 5000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (job && job.status !== "done") {
      pollRef.current = setInterval(async () => {
        const r = await api.get(`/broadcast/${job.id}`);
        setJob(r.data);
        if (r.data.status === "done" || r.data.status === "paused") clearInterval(pollRef.current);
      }, 1500);
      return () => clearInterval(pollRef.current);
    }
  }, [job?.id, job?.status]);

  const handleExcel = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const fd = new FormData();
    fd.append("file", f);
    try {
      const r = await api.post("/broadcast/parse-excel", fd);
      setContacts(r.data.contacts.slice(0, 50));
      toast.success(`${r.data.contacts.length} contacts loaded${r.data.contacts.length > 50 ? " (capped at 50)" : ""}`);
    } catch (err) {
      toast.error("Failed to parse file");
    }
  };

  const handlePaste = async () => {
    const r = await api.post("/broadcast/parse-paste", { text: pasteText });
    setContacts(r.data.contacts.slice(0, 50));
    toast.success(`${r.data.contacts.length} contacts found`);
  };

  const handleAttach = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const fd = new FormData();
    fd.append("file", f);
    const r = await api.post("/broadcast/upload-attachment", fd);
    setAttachment({ id: r.data.file_id, name: r.data.filename });
    toast.success("Attachment uploaded");
  };

  const start = async () => {
    if (contacts.length === 0) return toast.error("Add contacts first");
    if (contacts.length > 50) return toast.error("Max 50 contacts");
    if (!message && !attachment) return toast.error("Add a message or attachment");
    const r = await api.post("/broadcast/start", {
      contacts,
      message,
      mode,
      attachment_id: attachment?.id,
      attachment_name: attachment?.name,
      sender_id: pickedSender !== "auto" ? pickedSender : undefined,
    });
    setJob(r.data);
    toast.success("Blast queued");
  };

  const pause = async () => {
    if (!job) return;
    await api.post(`/broadcast/${job.id}/pause`);
    toast("Pausing...");
  };

  const removeContact = (i) => setContacts(contacts.filter((_, idx) => idx !== i));

  const addFromLeads = () => {
    const picked = savedLeads.filter((l) => pickerSel[l.id]).map((l) => ({ phone: l.phone, name: l.party_name }));
    setContacts([...contacts, ...picked].slice(0, 50));
    setPickerSel({});
    toast.success(`Added ${picked.length} from leads`);
  };

  const pct = job && job.total ? Math.round(((job.sent + job.failed) / job.total) * 100) : 0;

  return (
    <div className="space-y-5" data-testid="broadcaster-page">
      <div className="flex items-end justify-between pt-2">
        <div>
          <h1 className="font-[Manrope] text-3xl font-bold tracking-tight text-gray-900">Blast</h1>
          <p className="text-sm text-gray-500">Send WhatsApp message to up to 50 contacts</p>
        </div>
      </div>

      {/* Contacts source */}
      <div className="bg-white rounded-3xl border border-gray-200 p-4">
        <h2 className="font-[Manrope] text-base font-semibold mb-3">Add contacts</h2>
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="bg-gray-100 rounded-full h-11 w-full grid grid-cols-3 p-1" data-testid="contacts-source-tabs">
            <TabsTrigger value="excel" className="rounded-full data-[state=active]:bg-white data-[state=active]:shadow-sm" data-testid="tab-excel">
              <Upload className="w-4 h-4 mr-1" /> Excel
            </TabsTrigger>
            <TabsTrigger value="paste" className="rounded-full data-[state=active]:bg-white data-[state=active]:shadow-sm" data-testid="tab-paste">
              <Clipboard className="w-4 h-4 mr-1" /> Paste
            </TabsTrigger>
            <TabsTrigger value="leads" className="rounded-full data-[state=active]:bg-white data-[state=active]:shadow-sm" data-testid="tab-leads">
              <Users className="w-4 h-4 mr-1" /> Leads
            </TabsTrigger>
          </TabsList>

          <TabsContent value="excel" className="pt-4">
            <input ref={fileInput} type="file" hidden accept=".xlsx,.xls,.csv" onChange={handleExcel} />
            <Button onClick={() => fileInput.current?.click()} className="w-full h-12 rounded-full bg-emerald-600 hover:bg-emerald-700 press-fx" data-testid="upload-excel-btn">
              <Upload className="w-4 h-4 mr-2" /> Upload Excel/CSV
            </Button>
          </TabsContent>
          <TabsContent value="paste" className="pt-4 space-y-3">
            <Textarea
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              placeholder="Paste numbers here (one per line, e.g. 9876543210, Ravi)"
              className="min-h-[120px] rounded-2xl bg-gray-50 border-gray-200"
              data-testid="paste-textarea"
            />
            <Button onClick={handlePaste} className="w-full h-12 rounded-full bg-emerald-600 hover:bg-emerald-700 press-fx" data-testid="parse-paste-btn">
              Parse contacts
            </Button>
          </TabsContent>
          <TabsContent value="leads" className="pt-4 space-y-2">
            <div className="max-h-72 overflow-auto space-y-2 pr-1">
              {savedLeads.length === 0 && <p className="text-sm text-gray-500 text-center py-6">No saved leads yet</p>}
              {savedLeads.map((l) => (
                <label key={l.id} className="flex items-center gap-3 p-2.5 rounded-xl bg-gray-50 cursor-pointer">
                  <input
                    type="checkbox"
                    className="w-5 h-5 accent-emerald-600"
                    checked={!!pickerSel[l.id]}
                    onChange={(e) => setPickerSel({ ...pickerSel, [l.id]: e.target.checked })}
                    data-testid={`leads-pick-${l.id}`}
                  />
                  <div className="flex-1">
                    <div className="text-sm font-medium">{l.party_name}</div>
                    <div className="text-xs text-gray-500">{l.phone} • {l.city}</div>
                  </div>
                </label>
              ))}
            </div>
            <Button onClick={addFromLeads} className="w-full h-11 rounded-full bg-emerald-600 hover:bg-emerald-700 press-fx" data-testid="add-from-leads-btn">
              Add selected
            </Button>
          </TabsContent>
        </Tabs>

        {contacts.length > 0 && (
          <div className="mt-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold uppercase tracking-[0.2em] text-gray-500">{contacts.length} / 50 selected</span>
              <button onClick={() => setContacts([])} className="text-xs text-red-500 underline" data-testid="clear-contacts-btn">clear</button>
            </div>
            <div className="flex flex-wrap gap-2 max-h-32 overflow-auto" data-testid="contacts-chiplist">
              {contacts.map((c, i) => (
                <span key={i} className="inline-flex items-center gap-1 bg-emerald-50 text-emerald-700 text-xs px-3 py-1.5 rounded-full">
                  {c.name || c.phone}
                  <button onClick={() => removeContact(i)} className="hover:text-red-600"><X className="w-3 h-3" /></button>
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Message + attachment */}
      <div className="bg-white rounded-3xl border border-gray-200 p-4 space-y-3">
        <h2 className="font-[Manrope] text-base font-semibold">Message</h2>
        <Textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Type your message..."
          className="min-h-[100px] rounded-2xl bg-gray-50 border-gray-200"
          data-testid="message-textarea"
        />
        <div className="flex items-center gap-2">
          <input ref={attachInput} type="file" hidden onChange={handleAttach} />
          <Button variant="outline" onClick={() => attachInput.current?.click()} className="rounded-full h-10 border-gray-200 press-fx" data-testid="attach-btn">
            <Paperclip className="w-4 h-4 mr-1" /> {attachment ? "Replace" : "Attach"}
          </Button>
          {attachment && (
            <span className="inline-flex items-center gap-1 bg-emerald-50 text-emerald-700 text-xs px-3 py-1.5 rounded-full" data-testid="attachment-chip">
              {attachment.name}
              <button onClick={() => setAttachment(null)}><X className="w-3 h-3" /></button>
            </span>
          )}
        </div>
      </div>

      {/* Send from (sender picker) */}
      <div className="bg-white rounded-3xl border border-gray-200 p-4">
        <h2 className="font-[Manrope] text-base font-semibold mb-3">Send from</h2>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => setPickedSender("auto")}
            data-testid="sender-auto"
            className={`rounded-full px-4 h-10 text-sm border press-fx ${pickedSender === "auto" ? "border-emerald-600 bg-emerald-50 text-emerald-700 font-semibold" : "border-gray-200 bg-white text-gray-600"}`}
          >
            Auto (use Mode A/B)
          </button>
          {senders.map((s) => {
            const online = s.last_seen && (Date.now() - new Date(s.last_seen).getTime()) < 30000;
            return (
              <button
                key={s.id}
                onClick={() => setPickedSender(s.id)}
                data-testid={`sender-pick-${s.id}`}
                disabled={!online}
                className={`rounded-full px-4 h-10 text-sm border press-fx ${pickedSender === s.id ? "border-emerald-600 bg-emerald-50 text-emerald-700 font-semibold" : "border-gray-200 bg-white text-gray-600"} ${!online ? "opacity-40" : ""}`}
              >
                <span className={`inline-block w-2 h-2 rounded-full mr-1.5 ${online ? "bg-emerald-500" : "bg-gray-400"}`}></span>
                {s.label || s.id}
                {s.phone && <span className="text-[10px] text-gray-400 ml-1">+{s.phone.slice(-4)}</span>}
              </button>
            );
          })}
        </div>
        {pickedSender !== "auto" && (
          <p className="text-[11px] text-amber-600 mt-2">
            Forced single sender — Mode A/B is overridden, all messages go via this one number.
          </p>
        )}
      </div>

      {/* Mode toggle */}
      <div className="bg-white rounded-3xl border border-gray-200 p-4">
        <h2 className="font-[Manrope] text-base font-semibold mb-3">Mode</h2>
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => setMode("A")}
            data-testid="mode-a-btn"
            className={`rounded-2xl p-3 text-left border ${mode === "A" ? "border-emerald-600 bg-emerald-50" : "border-gray-200"} press-fx`}
          >
            <div className="text-sm font-semibold">Mode A</div>
            <div className="text-xs text-gray-500">Load split (1 sender per contact)</div>
          </button>
          <button
            onClick={() => setMode("B")}
            data-testid="mode-b-btn"
            className={`rounded-2xl p-3 text-left border ${mode === "B" ? "border-emerald-600 bg-emerald-50" : "border-gray-200"} press-fx`}
          >
            <div className="text-sm font-semibold">Mode B</div>
            <div className="text-xs text-gray-500">All senders blast each contact</div>
          </button>
        </div>
      </div>

      {/* Send / progress */}
      {!job || job.status === "done" ? (
        <Button onClick={start} className="w-full h-14 rounded-full bg-emerald-600 hover:bg-emerald-700 text-base font-semibold press-fx" data-testid="start-blast-btn">
          <Send className="w-5 h-5 mr-2" /> Start Blast ({contacts.length})
        </Button>
      ) : (
        <div className="bg-white rounded-3xl border border-gray-200 p-4 space-y-3" data-testid="blast-progress">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Status: {job.status}</span>
            <span className="text-xs text-gray-500">{job.sent + job.failed}/{job.total}</span>
          </div>
          <Progress value={pct} className="h-2" />
          <div className="grid grid-cols-2 gap-2 text-center">
            <div className="bg-emerald-50 rounded-xl p-2"><div className="text-xs text-gray-500">Sent</div><div className="font-semibold text-emerald-600">{job.sent}</div></div>
            <div className="bg-red-50 rounded-xl p-2"><div className="text-xs text-gray-500">Failed</div><div className="font-semibold text-red-600">{job.failed}</div></div>
          </div>
          {job.status === "running" && (
            <Button variant="outline" onClick={pause} className="w-full rounded-full h-11 press-fx" data-testid="pause-btn">
              <Pause className="w-4 h-4 mr-2" /> Pause
            </Button>
          )}
          {job.status === "done" && (
            <Button onClick={() => setJob(null)} className="w-full rounded-full h-11 bg-emerald-600 press-fx" data-testid="new-blast-btn">New blast</Button>
          )}
        </div>
      )}
    </div>
  );
}
