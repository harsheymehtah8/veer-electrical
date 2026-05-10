# Veer Electrical — WhatsApp Broadcaster + Smart Inbox CRM

## Original problem
Indian electrical-goods wholesaler needs a mobile-first dashboard to:
1. Blast WhatsApp messages with PDFs/videos to up to 50 contacts per blast using 2–3 connected sender numbers (Mode A load-split or Mode B duplicate-to-all)
2. Run an automated bot that captures leads (firm + city + state) and sends product pricelist PDFs through a Range → Brand → Series menu flow
3. Maintain a Lead CRM with a customizable 2-letter CAPS contact prefix tag (so leads are searchable in the owner's phone contacts)
4. Manage a catalog of Product Ranges → Brands → Series with PDF uploads
5. Edit bot message templates
6. Manage WhatsApp sender numbers (simulated)

## User personas
- **Single owner** (non-tech-savvy Indian SMB): primary user, uses phone, wants WhatsApp-like familiarity. Stub OTP login.

## Static core requirements
- Mobile-first responsive web app (looks/feels native, bottom nav)
- 50 contact cap per blast (hard-enforced backend)
- Bot is silent for repeat customers unless they type **`send pdf`**
- Bot sends ONLY the PDF after series selection (no caption text, per user request)
- Customizable 2-letter CAPS contact prefix tag (default `VE`) used as searchable contact-name prefix
- Product Range → Brand → Series → PDF tree, fully editable
- Editable bot message templates with placeholder support (`{firm}`, `{city}`, `{brand}`, etc.)

## Architecture
- **Frontend:** React 19 + Tailwind + Shadcn/ui, mobile-first, sonner toast, react-router-dom v7
- **Backend:** FastAPI + Motor (async MongoDB), all routes prefixed `/api`
- **DB:** MongoDB collections — settings, ranges, leads, senders, templates, bot_state, broadcasts, files, tokens
- **Auth:** Stub OTP (dev OTP returned in API response and shown on login screen). Bearer-token in MongoDB.
- **WhatsApp engine:** SIMULATED — bot replies returned synchronously via `/api/bot/incoming`; broadcast simulator marks messages sent/failed with random ~5% failure. Real Baileys/Cloud-API can be plugged in later via the same endpoints.
- **PDF storage:** local disk `/app/backend/uploads`. Phase 2: swap to Emergent object storage.

## What's been implemented (2026-05-06 — MVP release)
- ✅ Stub OTP login (single owner) — token persisted, auto-redirects on 401
- ✅ Settings (business name, prefix tag, owner phone)
- ✅ Catalog: Range / Brand / Series CRUD + PDF upload (5 × 4 × 4 seeded)
- ✅ Lead CRM: list, search, export to xlsx, delete, contact-prefix-tag avatar
- ✅ Bot state machine: new-customer lead capture → range → brand → series → PDF or fallback; returning customer silent except `send pdf`
- ✅ Bot Messages: 9 editable templates with placeholder chips + WhatsApp-style preview + reset-to-default
- ✅ Senders: CRUD + simulated QR connect with health badge + daily counter
- ✅ Broadcaster: 3 sources (Excel/CSV upload, paste-from-clipboard, pick-from-leads), 50-cap, Mode A/B, attachment, live progress polling, pause
- ✅ Bot Simulator: WhatsApp-style chat tester at `/simulator`
- ✅ Bottom nav (5 tabs: Blast / Leads / Catalog / Bot / More)

## 2026-05-10 — Global search + Templates + Groups update
- ✅ Contacts CRM full address book (6 fields, +91 normalization, unlimited contacts, CSV/Excel import + xlsx export)
- ✅ Bot leads upgrade existing manual contacts (no overwrite of name/shop)
- ✅ Blast Message Templates (CRUD with attachments) at `/blast-templates`
- ✅ Groups: max 50 per group, multi-membership, blast direct from group
- ✅ External Baileys Node.js worker integration (webhook secret, multi-sender Mode A/B)
- ✅ Master bot ON/OFF toggle + auto-replies gated to blasted/whitelisted numbers
- ✅ **Global search across Contacts, Groups, Blast Templates** — uniform `q` param, debounced UI, regex-safe via `re.escape` on all 3 endpoints (2026-05-10)
- ✅ Excel export verified for Contacts and Leads (xlsx StreamingResponse, ~5KB)
- ✅ Tests: `/app/backend/tests/test_search_export.py` — 17/17 passing

## 2026-05-10 — Production bug fixes (P0)
- ✅ **Bottom-nav iPhone overlap** fixed via `paddingBottom: calc(7rem + env(safe-area-inset-bottom))` in AppLayout
- ✅ **Broadcaster draft persistence** — message + contacts + mode + attachment + sender persisted to `sessionStorage('ve_blast_draft')`, hydrated on mount, cleared on successful blast start. No more loss when navigating to Contacts and back.
- ✅ **"Save as template" button** in Broadcaster — name + preview dialog, POSTs to `/api/blast-templates`
- ✅ **Phone validation** at blast time — rejects malformed (e.g. 11-digit `99870003415`); valid numbers normalized to E.164-ish (12-digit `91XXXXXXXXXX`); response includes `invalid_numbers` list of skipped raw inputs
- ✅ **Failure reasons surfaced** — worker now sends `failed: [{id, reason}]`, backend stores `error_reason` on outbox, Queue page renders ⚠ reason on each failed message; pre-flight `sock.onWhatsApp()` check in worker catches "Not registered on WhatsApp" before send
- ✅ Tests: `/app/backend/tests/test_broadcast_validation_and_ack.py` — 9/9 + 7/7 frontend flows passing

## Backlog (P0/P1/P2)

### P0 (next, before scaling)
- Plug in real WhatsApp engine: self-host Baileys worker on a VPS that POSTs incoming messages to `/api/bot/incoming` and reads outbound queue
- Authentication tightening: protect all write endpoints with `require_auth` dependency
- Move PDF storage to Emergent object storage so files survive redeploys

### P1
- Number health dashboard (24-h history, ban-warning detector hooks)
- Scheduled blasts (queue for tomorrow 10 AM)
- Customer segments (Dealer / Retail / Electrician)
- Templates library (one-click "Diwali offer", "New stock")
- File upload validation (size + MIME type for PDF)

### P2
- Multi-staff login (RBAC)
- Multi-language bot (English / Hindi / Gujarati)
- Per-range overrides for pricelist captions
- Auto-pause sender on WhatsApp warning + auto-rotate
- Warm-up mode for new SIMs (10 → 25 → 50/day over 2 weeks)

## Test credentials
See `/app/memory/test_credentials.md`. Login uses stub OTP — phone any number, OTP shown on screen.
