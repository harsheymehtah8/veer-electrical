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

  let connectedAt = 0; // Timestamp when 'open' event last fired

  sock.ev.on("connection.update", async (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr) {
      console.log(`\n📱 [${SENDER_ID}] SCAN THIS QR with WhatsApp (Settings -> Linked Devices -> Link a Device):\n`);
      qrcode.generate(qr, { small: true });
    }
    if (connection === "open") {
      connectedAt = Date.now();
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
      // Warm-up: don't send anything in the first 30s after a fresh connection.
      // Gives WhatsApp server time to propagate new sender keys to recipients,
      // preventing "Waiting for this message" on the receiving end.
      if (connectedAt > 0 && Date.now() - connectedAt < 30000) {
        return;
      }
      // Fetch ONE message at a time so the blast delay genuinely spaces out sends.
      // Fetching a batch causes the within-batch delay to be respected but the
      // *between-batch* gap to be small (just the poll interval).
      const batchSize = process.env.BATCH_SIZE ? parseInt(process.env.BATCH_SIZE, 10) : 1;
      const r = await veer.get("/api/whatsapp/outbox", { params: { sender_id: SENDER_ID, limit: batchSize } });
      const msgs = r.data.messages || [];
      for (const item of msgs) {
        const jid = `${item.phone}@s.whatsapp.net`;
        const p = item.payload;
        try {
          // Pre-flight: confirm the number is actually registered on WhatsApp.
          // Cheap call (cached server-side by Baileys) — saves "send to ghost" failures
          // that the WA server silently swallows.
          let onWA = true;
          try {
            const checks = await sock.onWhatsApp(item.phone);
            onWA = !!(checks && checks[0] && checks[0].exists);
          } catch (_) {
            onWA = true; // if check fails, attempt send anyway
          }
          if (!onWA) {
            throw new Error("Not registered on WhatsApp");
          }
          // ⭐ Pre-establish the Signal encryption session BEFORE sending.
          // Fixes "Waiting for this message" on recipient side — happens when sender
          // has a fresh identity (recently re-linked SIM) and recipient hasn't yet
          // received the new pre-keys. assertSessions fetches pre-keys explicitly so
          // the first message decrypts immediately.
          try {
            if (typeof sock.assertSessions === "function") {
              await sock.assertSessions([jid], true);
            }
          } catch (sessErr) {
            // Non-fatal — let the actual send try anyway. Common when contact has
            // privacy settings restricting prekey access.
            console.warn(`⚠️  [${SENDER_ID}] ${item.phone}: assertSessions warn: ${sessErr.message}`);
          }
          if (p.type === "text") {
            await sock.sendMessage(jid, { text: p.text });
          } else if (p.file_id) {
            // Fetch the media file once
            const fileUrl = `${VEER_API_URL}/api/files/${p.file_id}`;
            const fileRes = await axios.get(fileUrl, { responseType: "arraybuffer" });
            const buf = Buffer.from(fileRes.data);
            const filename = p.filename || `file`;
            const mime = p.mimetype || "application/octet-stream";

            // Branch on media kind so WhatsApp renders preview/playback correctly.
            // Caption is supported on image + video (renders inline below the media).
            const caption = p.caption || undefined;
            if (p.type === "image") {
              await sock.sendMessage(jid, { image: buf, mimetype: mime, fileName: filename, caption });
            } else if (p.type === "video") {
              await sock.sendMessage(jid, { video: buf, mimetype: mime, fileName: filename, caption });
            } else if (p.type === "audio") {
              await sock.sendMessage(jid, { audio: buf, mimetype: mime, ptt: false });
            } else {
              // pdf | document | any other -> send as document with explicit mimetype.
              // WhatsApp can show a caption for docs since 2023; pass it through too.
              await sock.sendMessage(jid, {
                document: buf,
                mimetype: mime,
                fileName: filename,
                ...(caption ? { caption } : {}),
              });
            }
          }
          console.log(`📤 [${SENDER_ID}] ${item.phone}: ${p.type}`);
          // Ack IMMEDIATELY so the dashboard flips from "Sending" to "Sent" right away,
          // instead of waiting for the whole batch's delays to finish.
          try {
            await veer.post("/api/whatsapp/ack", { sent: [item.id], failed: [], sender_id: SENDER_ID });
          } catch (ackErr) {
            console.warn(`⚠️  [${SENDER_ID}] ack-sent failed: ${ackErr.message}`);
          }
          // Anti-ban: blast delay is configurable via env (default 120-300s = 2-5 min).
          // 3-minute spread gives plenty of variation so WhatsApp can't fingerprint a cadence.
          // Bot replies stay fast (1-3s) since they're 1:1 conversational.
          // Treat unknown/missing broadcast_id as a blast (safer default while production
          // backend may not yet expose broadcast_id on the outbox endpoint).
          const isBlast = item.broadcast_id !== undefined ? !!item.broadcast_id : true;
          let delay;
          if (isBlast) {
            const minMs = parseInt(process.env.BLAST_DELAY_MIN_MS || "120000", 10);
            const maxMs = parseInt(process.env.BLAST_DELAY_MAX_MS || "300000", 10);
            const spread = Math.max(0, maxMs - minMs);
            delay = minMs + Math.random() * spread;
          } else {
            delay = 1000 + Math.random() * 2000;
          }
          console.log(`   ⏳ ${isBlast ? "BLAST" : "BOT"} delay ${Math.round(delay/1000)}s`);
          await new Promise((res) => setTimeout(res, delay));
        } catch (e) {
          const reason = (e && e.message) ? String(e.message).slice(0, 250) : "send failed";
          console.error(`❌ [${SENDER_ID}] ${item.phone}: ${reason}`);
          // Ack the failure immediately too so the dashboard shows it.
          try {
            await veer.post("/api/whatsapp/ack", { sent: [], failed: [{ id: item.id, reason }], sender_id: SENDER_ID });
          } catch (ackErr) {
            console.warn(`⚠️  [${SENDER_ID}] ack-failed failed: ${ackErr.message}`);
          }
        }
      }
      if (msgs.length > 0) {
        console.log(`📊 [${SENDER_ID}] batch complete (${msgs.length} processed)`);
      }
    } catch (e) {
      // dashboard temporarily unreachable
    }
  }, POLL_MS);
}

start().catch((e) => { console.error(e); process.exit(1); });
