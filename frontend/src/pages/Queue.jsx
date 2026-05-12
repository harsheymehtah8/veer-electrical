import { useEffect, useState } from "react";
import api from "@/lib/api";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { ArrowLeft, FileText, Clock, CheckCircle2, XCircle, Loader2, Ban, RotateCcw, Eraser } from "lucide-react";

export default function Queue() {
  const [stats, setStats] = useState({ totals: { pending: 0, sending: 0, sent: 0, failed: 0 }, by_sender: {} });
  const [recent, setRecent] = useState([]);
  const [senders, setSenders] = useState([]);
  const [cancelling, setCancelling] = useState(false);
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();

  const load = async () => {
    try {
      const [s, r, sd] = await Promise.all([
        api.get("/whatsapp/queue/stats"),
        api.get("/whatsapp/queue/recent", { params: { limit: 80 } }),
        api.get("/senders"),
      ]);
      setStats(s.data);
      setRecent(r.data);
      setSenders(sd.data);
    } catch {}
  };
  useEffect(() => {
    load();
    const id = setInterval(load, 3000);
    return () => clearInterval(id);
  }, []);

  const senderLabel = (id) => {
    const s = senders.find((x) => x.id === id);
    return s?.label || id || "—";
  };

  const fmtTime = (iso) => {
    if (!iso) return "—";
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  };

  const statusBadge = (s) => {
    switch (s) {
      case "pending":
        return { c: "bg-amber-50 text-amber-700", Icon: Clock, label: "Queued" };
      case "sending":
        return { c: "bg-blue-50 text-blue-700", Icon: Loader2, label: "Sending" };
      case "sent":
        return { c: "bg-emerald-50 text-emerald-700", Icon: CheckCircle2, label: "Sent" };
      case "failed":
        return { c: "bg-red-50 text-red-700", Icon: XCircle, label: "Failed" };
      case "cancelled":
        return { c: "bg-gray-100 text-gray-600", Icon: Ban, label: "Cancelled" };
      default:
        return { c: "bg-gray-50 text-gray-700", Icon: Clock, label: s };
    }
  };

  const cancelQueue = async () => {
    const pendingNow = (stats.totals.pending || 0) + (stats.totals.sending || 0);
    if (pendingNow === 0) {
      toast("No pending messages to cancel");
      return;
    }
    if (!window.confirm(`Cancel ${pendingNow} pending message${pendingNow > 1 ? "s" : ""}?\nAlready-sent messages won't be affected.`)) return;
    setCancelling(true);
    try {
      const r = await api.post("/whatsapp/queue/cancel-pending");
      toast.success(`Cancelled ${r.data.cancelled} message${r.data.cancelled !== 1 ? "s" : ""}`);
      load();
    } catch {
      toast.error("Failed to cancel queue");
    } finally {
      setCancelling(false);
    }
  };

  const retryFailed = async () => {
    const failedNow = stats.totals.failed || 0;
    if (failedNow === 0) {
      toast("No failed messages to retry");
      return;
    }
    if (!window.confirm(`Re-queue ${failedNow} failed message${failedNow > 1 ? "s" : ""}?`)) return;
    setBusy(true);
    try {
      const r = await api.post("/whatsapp/queue/retry-failed");
      toast.success(`Re-queued ${r.data.retried} message${r.data.retried !== 1 ? "s" : ""}`);
      load();
    } catch {
      toast.error("Retry failed");
    } finally {
      setBusy(false);
    }
  };

  const clearHistory = async () => {
    const total = (stats.totals.sent || 0) + (stats.totals.failed || 0) + (stats.totals.cancelled || 0);
    if (total === 0) {
      toast("Nothing to clear");
      return;
    }
    if (!window.confirm(`Delete ${total} history record${total > 1 ? "s" : ""}?\nPending and sending messages will be kept.`)) return;
    setBusy(true);
    try {
      const r = await api.post("/whatsapp/queue/clear-history");
      toast.success(`Cleared ${r.data.deleted} record${r.data.deleted !== 1 ? "s" : ""}`);
      load();
    } catch {
      toast.error("Clear failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4" data-testid="queue-page">
      <div className="flex items-center gap-3 pt-2">
        <button onClick={() => nav(-1)} className="w-10 h-10 rounded-full bg-white border border-gray-200 flex items-center justify-center press-fx" data-testid="back-btn">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="flex-1">
          <h1 className="font-[Manrope] text-2xl font-bold tracking-tight text-gray-900">Live Queue</h1>
          <p className="text-xs text-gray-500">Auto-refreshes every 3s • 4–5 min delay between sends</p>
        </div>
        {((stats.totals.pending || 0) + (stats.totals.sending || 0)) > 0 && (
          <Button
            onClick={cancelQueue}
            disabled={cancelling}
            variant="outline"
            className="rounded-full h-10 border-red-200 text-red-600 hover:bg-red-50 press-fx"
            data-testid="cancel-queue-btn"
          >
            <Ban className="w-4 h-4 mr-1" />
            {cancelling ? "Cancelling..." : "Cancel"}
          </Button>
        )}
      </div>

      {/* Queue actions row */}
      <div className="flex gap-2">
        <Button
          onClick={retryFailed}
          disabled={busy || !(stats.totals.failed || 0)}
          variant="outline"
          className="flex-1 rounded-full h-10 border-blue-200 text-blue-700 hover:bg-blue-50 disabled:opacity-50 press-fx"
          data-testid="retry-failed-btn"
        >
          <RotateCcw className="w-4 h-4 mr-1" />
          Retry {stats.totals.failed || 0} failed
        </Button>
        <Button
          onClick={clearHistory}
          disabled={busy || !((stats.totals.sent || 0) + (stats.totals.failed || 0) + (stats.totals.cancelled || 0))}
          variant="outline"
          className="flex-1 rounded-full h-10 border-gray-200 text-gray-700 hover:bg-gray-100 disabled:opacity-50 press-fx"
          data-testid="clear-history-btn"
        >
          <Eraser className="w-4 h-4 mr-1" />
          Clear history
        </Button>
      </div>

      {/* Totals */}
      <div className="grid grid-cols-4 gap-2" data-testid="queue-totals">
        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-3 text-center">
          <div className="text-[10px] uppercase font-semibold tracking-wider text-amber-700">Queued</div>
          <div className="text-2xl font-bold text-amber-700 mt-1">{stats.totals.pending || 0}</div>
        </div>
        <div className="bg-blue-50 border border-blue-200 rounded-2xl p-3 text-center">
          <div className="text-[10px] uppercase font-semibold tracking-wider text-blue-700">Sending</div>
          <div className="text-2xl font-bold text-blue-700 mt-1">{stats.totals.sending || 0}</div>
        </div>
        <div className="bg-emerald-50 border border-emerald-200 rounded-2xl p-3 text-center">
          <div className="text-[10px] uppercase font-semibold tracking-wider text-emerald-700">Sent</div>
          <div className="text-2xl font-bold text-emerald-700 mt-1">{stats.totals.sent || 0}</div>
        </div>
        <div className="bg-red-50 border border-red-200 rounded-2xl p-3 text-center">
          <div className="text-[10px] uppercase font-semibold tracking-wider text-red-700">Failed</div>
          <div className="text-2xl font-bold text-red-700 mt-1">{stats.totals.failed || 0}</div>
        </div>
      </div>

      {/* Per-sender breakdown */}
      <div className="bg-white rounded-3xl border border-gray-200 p-4">
        <h2 className="font-[Manrope] text-sm font-semibold mb-3">Per Sender</h2>
        <div className="space-y-2" data-testid="queue-by-sender">
          {Object.entries(stats.by_sender).map(([sid, counts]) => (
            <div key={sid} className="flex items-center gap-3 bg-gray-50 rounded-2xl p-3">
              <div className="font-[Manrope] font-semibold text-sm flex-1 truncate">{senderLabel(sid)}</div>
              <div className="flex gap-1.5 text-[11px]">
                <span className="px-2 py-1 rounded-full bg-amber-50 text-amber-700">⏱ {counts.pending || 0}</span>
                <span className="px-2 py-1 rounded-full bg-blue-50 text-blue-700">▶ {counts.sending || 0}</span>
                <span className="px-2 py-1 rounded-full bg-emerald-50 text-emerald-700">✓ {counts.sent || 0}</span>
                <span className="px-2 py-1 rounded-full bg-red-50 text-red-700">✗ {counts.failed || 0}</span>
              </div>
            </div>
          ))}
          {Object.keys(stats.by_sender).length === 0 && (
            <p className="text-sm text-gray-400 text-center py-3">No messages yet</p>
          )}
        </div>
      </div>

      {/* Recent feed */}
      <div className="bg-white rounded-3xl border border-gray-200 p-4">
        <h2 className="font-[Manrope] text-sm font-semibold mb-3">Recent activity</h2>
        <div className="space-y-1.5 max-h-[60vh] overflow-auto pr-1" data-testid="queue-recent">
          {recent.length === 0 && <p className="text-sm text-gray-400 text-center py-6">Queue is empty</p>}
          {recent.map((m) => {
            const { c, Icon, label } = statusBadge(m.status);
            const ts = m.sent_at || m.failed_at || m.created_at;
            return (
              <div key={m.id} className="flex items-center gap-2 py-2 border-b border-gray-100 last:border-0" data-testid={`queue-item-${m.id}`}>
                <span className={`inline-flex items-center gap-1 text-[10px] px-2 py-1 rounded-full font-medium shrink-0 ${c}`}>
                  <Icon className={`w-3 h-3 ${m.status === "sending" ? "animate-spin" : ""}`} />
                  {label}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-mono truncate">+{m.phone}</div>
                  <div className="text-[11px] text-gray-500 truncate">
                    {m.type === "pdf" ? <FileText className="w-3 h-3 inline mr-1" /> : null}
                    {m.preview || (m.type === "pdf" ? "PDF" : "—")}
                  </div>
                  {m.status === "failed" && m.error_reason && (
                    <div className="text-[10px] text-red-600 mt-0.5 truncate" data-testid={`fail-reason-${m.id}`}>
                      ⚠ {m.error_reason}
                    </div>
                  )}
                </div>
                <div className="text-right shrink-0">
                  <div className="text-[10px] text-gray-500">{senderLabel(m.sender_id)}</div>
                  <div className="text-[10px] text-gray-400 font-mono">{fmtTime(ts)}</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
