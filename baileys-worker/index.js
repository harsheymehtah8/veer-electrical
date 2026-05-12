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

  // Track recent failures so we can back off if WhatsApp's socket is unhappy.
  let recentFailures = []; // array of timestamps
  let backoffUntil = 0;    // ms epoch — don't send until past this

  const tick = async () => {
    try {
      // Warm-up: don't send anything in the first 30s after a fresh connection.
      if (connectedAt > 0 && Date.now() - connectedAt < 30000) {
        return;
      }
      // Backoff cooldown — if we're being rate-limited, just wait.
      if (Date.now() < backoffUntil) {
        const remaining = Math.round((backoffUntil - Date.now()) / 1000);
        console.log(`   ⏸️  [${SENDER_ID}] backoff active, ${remaining}s remaining`);
        return;
      }
      // Don't even fetch if the socket isn't open — saves a needless API roundtrip.
      if (!sock.ws || sock.ws.readyState !== 1) {
        return;
      }
      // Fetch ONE message at a time so the blast delay genuinely spaces out sends.
      const batchSize = process.env.BATCH_SIZE ? parseInt(process.env.BATCH_SIZE, 10) : 1;
      const r = await veer.get("/api/whatsapp/outbox", { params: { sender_id: SENDER_ID, limit: batchSize } });
      const msgs = r.data.messages || [];
      for (const item of msgs) {
        const jid = `${item.phone}@s.whatsapp.net`;
        const p = item.payload;
        let sendSucceeded = false;
        try {
          // Pre-flight: confirm the number is actually registered on WhatsApp.
          let onWA = true;
          try {
            const checks = await sock.onWhatsApp(item.phone);
            onWA = !!(checks && checks[0] && checks[0].exists);
          } catch (_) {
            onWA = true;
          }
          if (!onWA) {
            throw new Error("Not registered on WhatsApp");
          }
          // Pre-establish Signal session so recipient sees the message immediately.
          try {
            if (typeof sock.assertSessions === "function") {
              await sock.assertSessions([jid], true);
            }
          } catch (sessErr) {
            console.warn(`⚠️  [${SENDER_ID}] ${item.phone}: assertSessions warn: ${sessErr.message}`);
          }
          if (p.type === "text") {
            await sock.sendMessage(jid, { text: p.text });
          } else if (p.file_id) {
            const fileUrl = `${VEER_API_URL}/api/files/${p.file_id}`;
            const fileRes = await axios.get(fileUrl, { responseType: "arraybuffer" });
            const buf = Buffer.from(fileRes.data);
            const filename = p.filename || `file`;
            const mime = p.mimetype || "application/octet-stream";
            const caption = p.caption || undefined;
            if (p.type === "image") {
              await sock.sendMessage(jid, { image: buf, mimetype: mime, fileName: filename, caption });
            } else if (p.type === "video") {
              await sock.sendMessage(jid, { video: buf, mimetype: mime, fileName: filename, caption });
            } else if (p.type === "audio") {
              await sock.sendMessage(jid, { audio: buf, mimetype: mime, ptt: false });
            } else {
              await sock.sendMessage(jid, {
                document: buf,
                mimetype: mime,
                fileName: filename,
                ...(caption ? { caption } : {}),
              });
            }
          }
          sendSucceeded = true;
          console.log(`📤 [${SENDER_ID}] ${item.phone}: ${p.type}`);
          // Ack immediately so dashboard flips Sending -> Sent in real time.
          try {
            await veer.post("/api/whatsapp/ack", { sent: [item.id], failed: [], sender_id: SENDER_ID });
          } catch (ackErr) {
            console.warn(`⚠️  [${SENDER_ID}] ack-sent failed: ${ackErr.message}`);
          }
          // Reset failure tracking after each successful send.
          recentFailures = [];
        } catch (e) {
          const reason = (e && e.message) ? String(e.message).slice(0, 250) : "send failed";
          console.error(`❌ [${SENDER_ID}] ${item.phone}: ${reason}`);
          try {
            await veer.post("/api/whatsapp/ack", { sent: [], failed: [{ id: item.id, reason }], sender_id: SENDER_ID });
          } catch (ackErr) {
            console.warn(`⚠️  [${SENDER_ID}] ack-failed failed: ${ackErr.message}`);
          }
          // Track this failure for backoff calculation.
          recentFailures.push(Date.now());
          recentFailures = recentFailures.filter((t) => Date.now() - t < 60000); // keep 60s window
          // If 3+ failures in the last 60s, back off for 10 minutes.
          if (recentFailures.length >= 3) {
            backoffUntil = Date.now() + 10 * 60 * 1000;
            console.error(`🚨 [${SENDER_ID}] ${recentFailures.length} failures in 60s — backing off 10min to protect SIM`);
            recentFailures = []; // reset for next window
            break; // exit batch loop immediately
          }
        }
        // Apply delay regardless of success/failure — prevents rapid-fire retry storms
        // that look like spam to WhatsApp. Failures get a SHORTER delay (just long enough
        // to let the socket recover) while successes get the full anti-ban delay.
        let delay;
        if (sendSucceeded) {
          const isBlast = item.broadcast_id !== undefined ? !!item.broadcast_id : true;
          if (isBlast) {
            const minMs = parseInt(process.env.BLAST_DELAY_MIN_MS || "120000", 10);
            const maxMs = parseInt(process.env.BLAST_DELAY_MAX_MS || "300000", 10);
            delay = minMs + Math.random() * Math.max(0, maxMs - minMs);
          } else {
            delay = 1000 + Math.random() * 2000;
          }
        } else {
          // Failure cooldown — 20-30s before next attempt so we don't hammer a sick socket.
          delay = 20000 + Math.random() * 10000;
        }
        console.log(`   ⏳ ${sendSucceeded ? "SENT" : "FAIL-cooldown"} delay ${Math.round(delay / 1000)}s`);
        await new Promise((res) => setTimeout(res, delay));
      }
      if (msgs.length > 0) {
        console.log(`📊 [${SENDER_ID}] tick done (${msgs.length} processed)`);
      }
    } catch (e) {
      // dashboard temporarily unreachable — keep looping
    } finally {
      setTimeout(tick, POLL_MS);
    }
  };
  tick();
}

start().catch((e) => { console.error(e); process.exit(1); });
