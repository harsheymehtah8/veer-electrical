// Veer Electrical — Baileys WhatsApp Worker v2 (Multi-sender)
// Each instance has a unique SENDER_ID and links to its own SIM.
// Run multiple instances on the same VPS for multi-SIM blasting.

require("dotenv").config();
const path = require("path");
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
const SENDER_ID = process.env.SENDER_ID || "default";
const SENDER_LABEL = process.env.SENDER_LABEL || `Sender ${SENDER_ID}`;
const POLL_MS = parseInt(process.env.POLL_INTERVAL_MS || "2000", 10);

if (!VEER_API_URL || !SECRET) {
  console.error("❌ Set VEER_API_URL and WEBHOOK_SECRET in .env first.");
  process.exit(1);
}

const veer = axios.create({
  baseURL: VEER_API_URL,
  headers: { "X-Webhook-Secret": SECRET, "Content-Type": "application/json" },
  timeout: 15000,
});
const logger = pino({ level: "warn" });

// Each sender has its own auth folder so multiple workers don't clash
const AUTH_FOLDER = `auth_session_${SENDER_ID}`;

async function start() {
  console.log(`🚀 Starting Baileys worker — SENDER_ID=${SENDER_ID}, label=${SENDER_LABEL}`);
  console.log(`   Auth folder: ${AUTH_FOLDER}`);

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: ["VeerElectrical", "Chrome", SENDER_ID],
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr) {
      console.log(`\n📱 [${SENDER_ID}] SCAN THIS QR with WhatsApp (Settings -> Linked Devices -> Link a Device):\n`);
      qrcode.generate(qr, { small: true });
    }
    if (connection === "open") {
      const myNumber = sock.user?.id?.split(":")[0]?.split("@")[0] || "";
      console.log(`✅ [${SENDER_ID}] WhatsApp connected as +${myNumber}. Worker LIVE.`);
      // Register sender in dashboard
      try {
        await veer.post("/api/whatsapp/register", {
          sender_id: SENDER_ID,
          phone: myNumber,
          label: SENDER_LABEL,
        });
      } catch (e) {
        console.error(`❌ [${SENDER_ID}] Register failed:`, e.message);
      }
    }
    if (connection === "close") {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log(`⚠️ [${SENDER_ID}] Closed.`, shouldReconnect ? "Reconnecting..." : "Logged out — delete auth folder and restart to re-link.");
      if (shouldReconnect) start();
    }
  });

  // ---- Incoming customer messages → forward to dashboard ----
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const m of messages) {
      if (m.key.fromMe) continue;
      const remote = m.key.remoteJid || "";
      if (!remote.endsWith("@s.whatsapp.net")) continue;
      const phone = remote.split("@")[0];
      const text =
        m.message?.conversation ||
        m.message?.extendedTextMessage?.text ||
        m.message?.imageMessage?.caption ||
        "";
      if (!text) continue;
      try {
        await veer.post("/api/whatsapp/incoming", { phone, message: text, sender_id: SENDER_ID });
        console.log(`📥 [${SENDER_ID}] ${phone}: ${text.slice(0, 60)}`);
      } catch (e) {
        console.error(`❌ [${SENDER_ID}] Forward failed:`, e.response?.data || e.message);
      }
    }
  });

  // ---- Poll outbox for messages tagged with MY sender_id ----
  setInterval(async () => {
    try {
      const r = await veer.get("/api/whatsapp/outbox", { params: { sender_id: SENDER_ID, limit: 20 } });
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
            const pdfUrl = `${VEER_API_URL}/api/files/${p.file_id}`;
            const pdfRes = await axios.get(pdfUrl, { responseType: "arraybuffer" });
            await sock.sendMessage(jid, {
              document: Buffer.from(pdfRes.data),
              mimetype: "application/pdf",
              fileName: p.filename || "pricelist.pdf",
            });
          }
          sent.push(item.id);
          console.log(`📤 [${SENDER_ID}] ${item.phone}: ${p.type}`);
          // Anti-ban: random 8-25s for blast messages, 1-3s for bot replies
          const isBlast = !!p.broadcast_id;
          const delay = isBlast
            ? 8000 + Math.random() * 17000
            : 1000 + Math.random() * 2000;
          await new Promise((res) => setTimeout(res, delay));
        } catch (e) {
          console.error(`❌ [${SENDER_ID}] Send failed:`, e.message);
          failed.push(item.id);
        }
      }
      if (sent.length || failed.length) {
        await veer.post("/api/whatsapp/ack", { sent, failed, sender_id: SENDER_ID });
      }
    } catch (e) {
      // dashboard temporarily unreachable
    }
  }, POLL_MS);
}

start().catch((e) => { console.error(e); process.exit(1); });
