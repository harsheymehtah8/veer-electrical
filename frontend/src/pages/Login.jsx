import { useState } from "react";
import { useNavigate } from "react-router-dom";
import api from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { Zap } from "lucide-react";

export default function Login() {
  const nav = useNavigate();
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [stage, setStage] = useState("phone");
  const [devOtp, setDevOtp] = useState("");
  const [loading, setLoading] = useState(false);

  const sendOtp = async () => {
    if (!phone || phone.length < 8) {
      toast.error("Enter a valid phone number");
      return;
    }
    setLoading(true);
    try {
      const res = await api.post("/auth/send-otp", { phone });
      setDevOtp(res.data.dev_otp);
      setStage("otp");
      toast.success(`OTP sent. Dev OTP: ${res.data.dev_otp}`);
    } catch {
      toast.error("Failed to send OTP");
    } finally {
      setLoading(false);
    }
  };

  const verify = async () => {
    setLoading(true);
    try {
      const res = await api.post("/auth/verify-otp", { phone, otp });
      localStorage.setItem("ve_token", res.data.token);
      localStorage.setItem("ve_phone", res.data.phone);
      nav("/");
    } catch {
      toast.error("Invalid OTP");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen w-full flex flex-col items-center justify-center px-6 bg-gradient-to-b from-emerald-50 via-white to-amber-50">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-10">
          <div className="w-16 h-16 rounded-3xl bg-emerald-600 flex items-center justify-center mb-4 shadow-md">
            <Zap className="w-8 h-8 text-white" strokeWidth={2.4} />
          </div>
          <h1 className="font-[Manrope] text-3xl font-bold text-gray-900">Veer Electrical</h1>
          <p className="text-sm text-gray-500 mt-1">WhatsApp Broadcaster &amp; Smart Inbox</p>
        </div>

        {stage === "phone" ? (
          <div className="space-y-4" data-testid="login-phone-stage">
            <label className="text-xs font-semibold uppercase tracking-[0.2em] text-gray-500">
              Phone number
            </label>
            <Input
              data-testid="login-phone-input"
              value={phone}
              onChange={(e) => setPhone(e.target.value.replace(/\D/g, ""))}
              placeholder="98765 43210"
              className="h-14 text-lg rounded-2xl bg-white border-gray-200"
              inputMode="numeric"
            />
            <Button
              data-testid="login-send-otp-btn"
              disabled={loading}
              onClick={sendOtp}
              className="w-full h-14 rounded-full bg-emerald-600 hover:bg-emerald-700 text-base font-semibold press-fx"
            >
              {loading ? "Sending..." : "Send OTP"}
            </Button>
            <p className="text-xs text-gray-400 text-center">
              Single-owner login. OTP shown on screen during dev.
            </p>
          </div>
        ) : (
          <div className="space-y-4" data-testid="login-otp-stage">
            <p className="text-sm text-gray-600">
              OTP sent to <span className="font-semibold">+{phone}</span>{" "}
              <button
                onClick={() => setStage("phone")}
                className="text-emerald-600 underline ml-1"
                data-testid="login-edit-phone"
              >
                edit
              </button>
            </p>
            {devOtp && (
              <div className="text-xs bg-amber-50 border border-amber-200 text-amber-800 rounded-xl px-3 py-2">
                Dev OTP: <span className="font-mono font-semibold">{devOtp}</span>
              </div>
            )}
            <Input
              data-testid="login-otp-input"
              value={otp}
              onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="6-digit OTP"
              className="h-14 text-lg rounded-2xl bg-white border-gray-200 tracking-widest text-center font-mono"
              inputMode="numeric"
            />
            <Button
              data-testid="login-verify-btn"
              disabled={loading || otp.length !== 6}
              onClick={verify}
              className="w-full h-14 rounded-full bg-emerald-600 hover:bg-emerald-700 text-base font-semibold press-fx"
            >
              {loading ? "Verifying..." : "Verify & Enter"}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
