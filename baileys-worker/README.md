# Veer Electrical — Baileys WhatsApp Worker

Runs on your Oracle VPS. Connects your WhatsApp number, forwards incoming customer
messages to the Veer dashboard, and sends outgoing messages from the queue.

## One-time setup on the VPS (Ubuntu 22.04)

```bash
# 1. Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs git

# 2. Get this worker (replace with the actual path or scp it up)
mkdir -p ~/veer && cd ~/veer
# (upload package.json, index.js, .env.example here)

# 3. Install deps
npm install

# 4. Configure
cp .env.example .env
nano .env   # paste WEBHOOK_SECRET from dashboard Settings page

# 5. Run forever with PM2
sudo npm install -g pm2
pm2 start index.js --name veer-bot
pm2 save
pm2 startup     # follow the instructions printed (one command to copy-paste back)

# 6. Watch logs (and scan the QR code that appears)
pm2 logs veer-bot
```

When the QR appears in the logs, open WhatsApp on the SIM you want to use →
**Settings → Linked Devices → Link a Device** → scan.

That's it. ✅

## Useful PM2 commands
```bash
pm2 logs veer-bot      # see live logs (Ctrl+C to exit, bot keeps running)
pm2 restart veer-bot   # restart
pm2 stop veer-bot      # stop
pm2 status             # status
```

## How it works
- **Incoming:** WhatsApp → Baileys → `POST /api/whatsapp/incoming` → bot processes → reply queued
- **Outgoing:** worker polls `GET /api/whatsapp/outbox` every 2s → sends each via Baileys → `POST /api/whatsapp/ack`
- **Heartbeat:** every poll updates `worker_status` so the dashboard shows "Online"
