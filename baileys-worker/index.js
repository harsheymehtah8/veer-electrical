// Veer Electrical — Baileys WhatsApp Worker
// Runs on your Oracle VPS. Connects your WhatsApp number via QR scan,
// forwards incoming messages to the dashboard, and sends outgoing messages from the queue.

require("dotenv").config();
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const qrcode = require("qrcode-terminal");
const axios = require("axios");
const pino = require("pino");

const VEER_API_URL = process.env.VEER_API_URL?.replace(/\/$/, "");
const SECRET = process.env.WEBHOOK_SECRET;
const POLL_MS = parseInt(process.env.POLL_INTERVAL_MS || "2000", 10);

if (!VEER_API_URL || !SECRET || SECRET === "PASTE_YOUR_SECRET_HERE") {
  console.error("❌ Set VEER_API_URL and WEBHOOK_SECRET in .env first.");
  process.exit(1);
}

const veer = axios.create({
  baseURL: VEER_API_URL,
  headers: { "X-Webhook-Secret": SECRET, "Content-Type": "application/json" },
  timeout: 15000,
});

const logger = pino({ level: "warn" });

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_session");
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: ["VeerElectrical", "Chrome", "1.0.0"],
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr) {
      console.log("\n📱 Scan this QR with your WhatsApp (Settings → Linked Devices → Link a Device):\n");
      qrcode.generate(qr, { small: true });
    }
    if (connection === "open") {
      console.log("✅ WhatsApp connected. Worker is live.");
    }
    if (connection === "close") {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log("⚠️ Connection closed.", shouldReconnect ? "Reconnecting..." : "Logged out.");
      if (shouldReconnect) start();
    }
  });

  // ---- Incoming customer messages → forward to dashboard ----
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const m of messages) {
      if (m.key.fromMe) continue;
      const remote = m.key.remoteJid || "";
      if (!remote.endsWith("@s.whatsapp.net")) continue; // ignore groups/status
      const phone = remote.split("@")[0];
      const text =
        m.message?.conversation ||
        m.message?.extendedTextMessage?.text ||
        m.message?.imageMessage?.caption ||
        "";
      if (!text) continue;
      try {
        await veer.post("/api/whatsapp/incoming", { phone, message: text });
        console.log(`📥 ${phone}: ${text.slice(0, 60)}`);
      } catch (e) {
        console.error("❌ Forward failed:", e.response?.data || e.message);
      }
    }
  });

  // ---- Poll outbox → send queued replies ----
  setInterval(async () => {
    try {
      const r = await veer.get("/api/whatsapp/outbox", { params: { limit: 20 } });
      const msgs = r.data.messages || [];
      const sent = [];
      const failed = [];
      for (const item of msgs) {
        const jid = `${item.phone}@s.whatsapp.net`;
        const p = item.payload;
        try {
          if (p.type === "text") {
            await sock.sendMessage(jid, { text: p.text });
          } else if (p.type === "pdf" && p.file_id) {
            // Download PDF from dashboard and send as document
            const pdfUrl = `${VEER_API_URL}/api/files/${p.file_id}`;
            const pdfRes = await axios.get(pdfUrl, { responseType: "arraybuffer" });
            await sock.sendMessage(jid, {
              document: Buffer.from(pdfRes.data),
              mimetype: "application/pdf",
              fileName: p.filename || "pricelist.pdf",
            });
          }
          sent.push(item.id);
          console.log(`📤 ${item.phone}: ${p.type}`);
          // Small natural delay between sends (anti-ban)
          await new Promise((res) => setTimeout(res, 800 + Math.random() * 1200));
        } catch (e) {
          console.error("❌ Send failed:", e.message);
          failed.push(item.id);
        }
      }
      if (sent.length || failed.length) {
        await veer.post("/api/whatsapp/ack", { sent, failed });
      }
    } catch (e) {
      // swallow - dashboard might be temporarily unreachable
    }
  }, POLL_MS);

  // Heartbeat ping (in case there's no traffic)
  setInterval(async () => {
    try { await veer.get("/api/whatsapp/outbox", { params: { limit: 0 } }); } catch {}
  }, 15000);
}

start().catch((e) => { console.error(e); process.exit(1); });
