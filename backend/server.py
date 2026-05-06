from fastapi import FastAPI, APIRouter, HTTPException, UploadFile, File, Form, Header, BackgroundTasks
from fastapi.responses import FileResponse, StreamingResponse
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os
import io
import re
import random
import asyncio
import logging
from pathlib import Path
from pydantic import BaseModel, Field, ConfigDict
from typing import List, Optional, Dict, Any
import uuid
from datetime import datetime, timezone
import pandas as pd

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

UPLOAD_DIR = ROOT_DIR / 'uploads'
UPLOAD_DIR.mkdir(exist_ok=True)

mongo_url = os.environ['MONGO_URL']
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ['DB_NAME']]

app = FastAPI(title="Veer Electrical")
api = APIRouter(prefix="/api")

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def new_id():
    return str(uuid.uuid4())


# ============ MODELS ============
class OTPRequest(BaseModel):
    phone: str

class OTPVerify(BaseModel):
    phone: str
    otp: str

class Settings(BaseModel):
    business_name: str = "Veer Electrical"
    prefix_tag: str = "VE"
    owner_phone: str = ""

class Series(BaseModel):
    id: str
    name: str
    pdf_id: Optional[str] = None
    pdf_filename: Optional[str] = None

class Brand(BaseModel):
    id: str
    name: str
    series: List[Series] = []

class ProductRange(BaseModel):
    id: str
    name: str
    brands: List[Brand] = []

class Lead(BaseModel):
    id: str
    phone: str
    party_name: str
    city: str
    state: str
    prefix_tag: str
    interested_range: Optional[str] = None
    interested_brand: Optional[str] = None
    interested_series: Optional[str] = None
    pdf_pending: bool = False
    status: str = "new"  # new, pricelist_sent, awaiting_callback
    created_at: str
    last_interaction: str

class Sender(BaseModel):
    id: str
    label: str
    phone: str
    status: str = "Healthy"  # Healthy, Caution, Risk
    daily_sent: int = 0
    daily_cap: int = 50

class Template(BaseModel):
    id: str
    name: str
    text: str

class BroadcastJob(BaseModel):
    id: str
    contacts: List[Dict[str, str]]
    message: str
    attachment_id: Optional[str] = None
    attachment_name: Optional[str] = None
    mode: str  # A or B
    status: str = "queued"  # queued, running, paused, done
    sent: int = 0
    failed: int = 0
    total: int = 0
    progress: List[Dict[str, Any]] = []
    created_at: str

class BotIncoming(BaseModel):
    phone: str
    message: str

# ============ AUTH (stub OTP) ============
otp_store: Dict[str, str] = {}

@api.post("/auth/send-otp")
async def send_otp(req: OTPRequest):
    otp = f"{random.randint(100000, 999999)}"
    otp_store[req.phone] = otp
    # In production, send via Twilio/MSG91
    return {"ok": True, "dev_otp": otp, "message": "OTP sent (stub mode)"}

@api.post("/auth/verify-otp")
async def verify_otp(req: OTPVerify):
    expected = otp_store.get(req.phone)
    if not expected or expected != req.otp:
        raise HTTPException(status_code=401, detail="Invalid OTP")
    otp_store.pop(req.phone, None)
    # Persist owner phone in settings if not set
    settings = await db.settings.find_one({"_id": "settings"}, {"_id": 0})
    if not settings:
        await db.settings.insert_one({"_id": "settings", **Settings(owner_phone=req.phone).model_dump()})
    elif not settings.get("owner_phone"):
        await db.settings.update_one({"_id": "settings"}, {"$set": {"owner_phone": req.phone}})
    token = new_id()
    await db.tokens.insert_one({"_id": token, "phone": req.phone, "created_at": now_iso()})
    return {"token": token, "phone": req.phone}

async def require_auth(authorization: Optional[str] = Header(None)):
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Auth required")
    token = authorization.replace("Bearer ", "")
    rec = await db.tokens.find_one({"_id": token})
    if not rec:
        raise HTTPException(status_code=401, detail="Invalid token")
    return rec.get("phone")

# ============ SETTINGS ============
@api.get("/settings")
async def get_settings():
    s = await db.settings.find_one({"_id": "settings"}, {"_id": 0})
    if not s:
        s = Settings().model_dump()
        await db.settings.insert_one({"_id": "settings", **s})
    return s

@api.put("/settings")
async def update_settings(s: Settings):
    await db.settings.update_one({"_id": "settings"}, {"$set": s.model_dump()}, upsert=True)
    return s.model_dump()

# ============ CATALOG ============
@api.get("/catalog")
async def get_catalog():
    items = await db.ranges.find({}, {"_id": 0}).to_list(1000)
    items.sort(key=lambda x: x.get("name", ""))
    return items

@api.post("/catalog/range")
async def create_range(payload: Dict[str, str]):
    r = ProductRange(id=new_id(), name=payload["name"], brands=[]).model_dump()
    await db.ranges.insert_one({"_id": r["id"], **r})
    return r

@api.delete("/catalog/range/{range_id}")
async def delete_range(range_id: str):
    await db.ranges.delete_one({"_id": range_id})
    return {"ok": True}

@api.post("/catalog/range/{range_id}/brand")
async def create_brand(range_id: str, payload: Dict[str, str]):
    brand = Brand(id=new_id(), name=payload["name"], series=[]).model_dump()
    await db.ranges.update_one({"_id": range_id}, {"$push": {"brands": brand}})
    return brand

@api.delete("/catalog/range/{range_id}/brand/{brand_id}")
async def delete_brand(range_id: str, brand_id: str):
    await db.ranges.update_one({"_id": range_id}, {"$pull": {"brands": {"id": brand_id}}})
    return {"ok": True}

@api.post("/catalog/range/{range_id}/brand/{brand_id}/series")
async def create_series(range_id: str, brand_id: str, payload: Dict[str, str]):
    series = Series(id=new_id(), name=payload["name"]).model_dump()
    await db.ranges.update_one(
        {"_id": range_id, "brands.id": brand_id},
        {"$push": {"brands.$.series": series}}
    )
    return series

@api.delete("/catalog/range/{range_id}/brand/{brand_id}/series/{series_id}")
async def delete_series(range_id: str, brand_id: str, series_id: str):
    await db.ranges.update_one(
        {"_id": range_id, "brands.id": brand_id},
        {"$pull": {"brands.$.series": {"id": series_id}}}
    )
    return {"ok": True}

@api.post("/catalog/range/{range_id}/brand/{brand_id}/series/{series_id}/pdf")
async def upload_pdf(range_id: str, brand_id: str, series_id: str, file: UploadFile = File(...)):
    file_id = new_id()
    ext = Path(file.filename).suffix or ".pdf"
    save_path = UPLOAD_DIR / f"{file_id}{ext}"
    content = await file.read()
    save_path.write_bytes(content)
    await db.files.insert_one({"_id": file_id, "filename": file.filename, "path": str(save_path), "uploaded_at": now_iso()})
    # Update series in catalog
    range_doc = await db.ranges.find_one({"_id": range_id})
    if not range_doc:
        raise HTTPException(404, "Range not found")
    for brand in range_doc.get("brands", []):
        if brand["id"] == brand_id:
            for s in brand.get("series", []):
                if s["id"] == series_id:
                    s["pdf_id"] = file_id
                    s["pdf_filename"] = file.filename
    await db.ranges.update_one({"_id": range_id}, {"$set": {"brands": range_doc["brands"]}})
    return {"file_id": file_id, "filename": file.filename}

@api.get("/files/{file_id}")
async def serve_file(file_id: str):
    rec = await db.files.find_one({"_id": file_id})
    if not rec:
        raise HTTPException(404)
    p = Path(rec["path"])
    if not p.exists():
        raise HTTPException(404)
    return FileResponse(str(p), filename=rec["filename"])

# ============ LEADS ============
@api.get("/leads")
async def list_leads(q: Optional[str] = None, city: Optional[str] = None, state: Optional[str] = None):
    query = {}
    if city:
        query["city"] = {"$regex": city, "$options": "i"}
    if state:
        query["state"] = {"$regex": state, "$options": "i"}
    if q:
        query["$or"] = [
            {"party_name": {"$regex": q, "$options": "i"}},
            {"phone": {"$regex": q, "$options": "i"}},
            {"city": {"$regex": q, "$options": "i"}},
        ]
    leads = await db.leads.find(query, {"_id": 0}).sort("created_at", -1).to_list(1000)
    return leads

@api.delete("/leads/{lead_id}")
async def delete_lead(lead_id: str):
    await db.leads.delete_one({"id": lead_id})
    await db.bot_state.delete_one({"_id": ""})  # noop
    return {"ok": True}

@api.get("/leads/export")
async def export_leads():
    leads = await db.leads.find({}, {"_id": 0}).sort("created_at", -1).to_list(10000)
    df = pd.DataFrame(leads)
    if df.empty:
        df = pd.DataFrame(columns=["phone", "party_name", "city", "state", "prefix_tag", "interested_range", "interested_brand", "interested_series", "status", "created_at"])
    buf = io.BytesIO()
    df.to_excel(buf, index=False, engine='openpyxl')
    buf.seek(0)
    return StreamingResponse(buf, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                             headers={"Content-Disposition": "attachment; filename=leads.xlsx"})

# ============ SENDERS ============
@api.get("/senders")
async def list_senders():
    items = await db.senders.find({}, {"_id": 0}).to_list(100)
    return items

@api.post("/senders")
async def create_sender(payload: Dict[str, str]):
    s = Sender(id=new_id(), label=payload.get("label", "Sender"), phone=payload.get("phone", "")).model_dump()
    await db.senders.insert_one({"_id": s["id"], **s})
    return s

@api.delete("/senders/{sender_id}")
async def delete_sender(sender_id: str):
    await db.senders.delete_one({"_id": sender_id})
    return {"ok": True}

@api.post("/senders/{sender_id}/connect")
async def connect_sender(sender_id: str):
    # Simulated connect: mark Healthy
    await db.senders.update_one({"_id": sender_id}, {"$set": {"status": "Healthy", "daily_sent": 0}})
    return {"ok": True, "qr_simulated": True}

# ============ TEMPLATES ============
DEFAULT_TEMPLATES = [
    {"id": "lead_capture", "name": "Lead capture (first reply)",
     "text": "Hi! Before we share pricelists, please share:\n🏢 Firm name\n🏙️ City\n🗺️ State\n\nFormat: Veer Traders, Surat, Gujarat"},
    {"id": "saved_confirm", "name": "Saved confirmation",
     "text": "✅ Saved as {prefix} {firm} - {city}.\nVeer ji will personally call/text you."},
    {"id": "range_menu", "name": "Product range menu",
     "text": "Pick a product range:\n{range_list}"},
    {"id": "brand_menu", "name": "Brand menu",
     "text": "Pick a brand for {range}:\n{brand_list}"},
    {"id": "series_menu", "name": "Series menu",
     "text": "Pick a series for {brand}:\n{series_list}"},
    {"id": "pdf_missing", "name": "PDF not uploaded fallback",
     "text": "📋 Pricelist for {brand} {series} is being updated. Veer ji will share it within 24 hours."},
    {"id": "send_pdf_trigger", "name": "Returning customer trigger word",
     "text": "send pdf"},
    {"id": "invalid_input", "name": "Invalid menu input",
     "text": "Sorry, I didn't catch that. Please reply with a number from the menu."},
    {"id": "bad_format", "name": "Bad firm format",
     "text": "Please share in this exact format:\nVeer Traders, Surat, Gujarat"},
]

@api.get("/templates")
async def list_templates():
    items = await db.templates.find({}, {"_id": 0}).to_list(100)
    return items

@api.put("/templates/{template_id}")
async def update_template(template_id: str, payload: Dict[str, str]):
    await db.templates.update_one({"id": template_id}, {"$set": {"text": payload["text"]}})
    return {"ok": True}

@api.post("/templates/reset/{template_id}")
async def reset_template(template_id: str):
    default = next((t for t in DEFAULT_TEMPLATES if t["id"] == template_id), None)
    if not default:
        raise HTTPException(404)
    await db.templates.update_one({"id": template_id}, {"$set": {"text": default["text"]}})
    return default

# ============ BOT ENGINE ============
async def get_template(tid: str) -> str:
    t = await db.templates.find_one({"id": tid}, {"_id": 0})
    if t:
        return t["text"]
    d = next((x for x in DEFAULT_TEMPLATES if x["id"] == tid), None)
    return d["text"] if d else ""

async def get_state(phone: str):
    return await db.bot_state.find_one({"_id": phone})

async def set_state(phone: str, data: Dict[str, Any]):
    await db.bot_state.update_one({"_id": phone}, {"$set": data}, upsert=True)

async def clear_state(phone: str):
    await db.bot_state.delete_one({"_id": phone})

async def existing_lead(phone: str):
    return await db.leads.find_one({"phone": phone}, {"_id": 0})

def numbered_list(items: List[str]) -> str:
    return "\n".join([f"{i+1}. {n}" for i, n in enumerate(items)])

async def bot_process(phone: str, message: str) -> List[Dict[str, Any]]:
    """Returns list of bot replies. Each reply: {type: 'text'|'pdf', text/file_id/filename}"""
    msg = (message or "").strip()
    msg_lower = msg.lower()
    replies: List[Dict[str, Any]] = []
    settings = await db.settings.find_one({"_id": "settings"}, {"_id": 0}) or Settings().model_dump()
    prefix = settings.get("prefix_tag", "VE")

    state = await get_state(phone)
    lead = await existing_lead(phone)

    # Returning customer flow
    if lead and not state:
        if msg_lower == "send pdf":
            # show range menu
            ranges = await db.ranges.find({}, {"_id": 0}).to_list(100)
            range_names = [r["name"] for r in ranges]
            tmpl = await get_template("range_menu")
            text = tmpl.replace("{range_list}", numbered_list(range_names))
            await set_state(phone, {"step": "range", "ranges": ranges})
            replies.append({"type": "text", "text": text})
            return replies
        else:
            # silent — no reply
            return replies

    # New customer — no lead, no state
    if not lead and not state:
        replies.append({"type": "text", "text": await get_template("lead_capture")})
        await set_state(phone, {"step": "capturing_lead"})
        return replies

    step = state.get("step") if state else None

    if step == "capturing_lead":
        parts = [p.strip() for p in msg.split(",")]
        if len(parts) < 3 or not all(parts[:3]):
            replies.append({"type": "text", "text": await get_template("bad_format")})
            return replies
        firm, city, st = parts[0], parts[1], parts[2]
        # Save lead
        lead_doc = Lead(
            id=new_id(), phone=phone, party_name=firm, city=city, state=st,
            prefix_tag=prefix, status="new",
            created_at=now_iso(), last_interaction=now_iso()
        ).model_dump()
        await db.leads.insert_one(lead_doc)
        # confirm
        confirm = (await get_template("saved_confirm")) \
            .replace("{prefix}", prefix).replace("{firm}", firm).replace("{city}", city).replace("{state}", st)
        replies.append({"type": "text", "text": confirm})
        # show range menu
        ranges = await db.ranges.find({}, {"_id": 0}).to_list(100)
        range_names = [r["name"] for r in ranges]
        tmpl = await get_template("range_menu")
        text = tmpl.replace("{range_list}", numbered_list(range_names))
        await set_state(phone, {"step": "range", "ranges": ranges})
        replies.append({"type": "text", "text": text})
        return replies

    if step == "range":
        ranges = state.get("ranges", [])
        try:
            idx = int(msg) - 1
            r = ranges[idx]
        except (ValueError, IndexError):
            replies.append({"type": "text", "text": await get_template("invalid_input")})
            return replies
        brand_names = [b["name"] for b in r.get("brands", [])]
        if not brand_names:
            replies.append({"type": "text", "text": "No brands configured for this range. Veer ji will reach out personally."})
            await clear_state(phone)
            return replies
        tmpl = await get_template("brand_menu")
        text = tmpl.replace("{range}", r["name"]).replace("{brand_list}", numbered_list(brand_names))
        await set_state(phone, {"step": "brand", "range": r})
        replies.append({"type": "text", "text": text})
        return replies

    if step == "brand":
        r = state.get("range", {})
        brands = r.get("brands", [])
        try:
            idx = int(msg) - 1
            b = brands[idx]
        except (ValueError, IndexError):
            replies.append({"type": "text", "text": await get_template("invalid_input")})
            return replies
        series_names = [s["name"] for s in b.get("series", [])]
        if not series_names:
            replies.append({"type": "text", "text": "No series configured. Veer ji will share details personally."})
            await clear_state(phone)
            return replies
        tmpl = await get_template("series_menu")
        text = tmpl.replace("{brand}", b["name"]).replace("{series_list}", numbered_list(series_names))
        await set_state(phone, {"step": "series", "range": r, "brand": b})
        replies.append({"type": "text", "text": text})
        return replies

    if step == "series":
        r = state.get("range", {})
        b = state.get("brand", {})
        series_list = b.get("series", [])
        try:
            idx = int(msg) - 1
            s = series_list[idx]
        except (ValueError, IndexError):
            replies.append({"type": "text", "text": await get_template("invalid_input")})
            return replies
        # Update lead with interest
        await db.leads.update_one({"phone": phone}, {"$set": {
            "interested_range": r["name"], "interested_brand": b["name"],
            "interested_series": s["name"], "last_interaction": now_iso()
        }})
        if s.get("pdf_id"):
            replies.append({"type": "pdf", "file_id": s["pdf_id"], "filename": s.get("pdf_filename") or "pricelist.pdf"})
            await db.leads.update_one({"phone": phone}, {"$set": {"status": "pricelist_sent", "pdf_pending": False}})
        else:
            tmpl = await get_template("pdf_missing")
            text = tmpl.replace("{brand}", b["name"]).replace("{series}", s["name"])
            replies.append({"type": "text", "text": text})
            await db.leads.update_one({"phone": phone}, {"$set": {"pdf_pending": True, "status": "awaiting_callback"}})
        await clear_state(phone)
        return replies

    return replies

@api.post("/bot/incoming")
async def bot_incoming(body: BotIncoming):
    replies = await bot_process(body.phone, body.message)
    return {"replies": replies}

@api.post("/bot/reset/{phone}")
async def bot_reset(phone: str):
    await clear_state(phone)
    await db.leads.delete_many({"phone": phone})
    return {"ok": True}

# ============ BROADCAST ============
@api.post("/broadcast/parse-excel")
async def parse_excel(file: UploadFile = File(...)):
    content = await file.read()
    try:
        df = pd.read_excel(io.BytesIO(content)) if file.filename.endswith((".xlsx", ".xls")) else pd.read_csv(io.BytesIO(content))
    except Exception as e:
        raise HTTPException(400, f"Failed to parse file: {e}")
    contacts = []
    for _, row in df.iterrows():
        phone = ""
        name = ""
        for col in df.columns:
            val = str(row[col]).strip() if not pd.isna(row[col]) else ""
            if not val:
                continue
            if re.search(r'\d{7,}', val) and not phone:
                phone = re.sub(r'\D', '', val)
            elif not name:
                name = val
        if phone:
            contacts.append({"phone": phone, "name": name or phone})
    return {"contacts": contacts[:200]}

@api.post("/broadcast/parse-paste")
async def parse_paste(payload: Dict[str, str]):
    text = payload.get("text", "")
    contacts = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        # split by tab/comma
        parts = re.split(r'[,\t]', line)
        phone = ""
        name = ""
        for p in parts:
            p = p.strip()
            if re.search(r'\d{7,}', p) and not phone:
                phone = re.sub(r'\D', '', p)
            elif p and not name:
                name = p
        if phone:
            contacts.append({"phone": phone, "name": name or phone})
    return {"contacts": contacts[:200]}

@api.post("/broadcast/upload-attachment")
async def upload_attachment(file: UploadFile = File(...)):
    file_id = new_id()
    ext = Path(file.filename).suffix
    save_path = UPLOAD_DIR / f"{file_id}{ext}"
    content = await file.read()
    save_path.write_bytes(content)
    await db.files.insert_one({"_id": file_id, "filename": file.filename, "path": str(save_path), "uploaded_at": now_iso()})
    return {"file_id": file_id, "filename": file.filename}

async def run_broadcast(job_id: str):
    job = await db.broadcasts.find_one({"_id": job_id})
    if not job:
        return
    senders = await db.senders.find({}, {"_id": 0}).to_list(100)
    if not senders:
        senders = [{"id": "default", "label": "Default", "phone": "0000000000"}]
    contacts = job["contacts"]
    mode = job["mode"]
    total_msgs = len(contacts) * (len(senders) if mode == "B" else 1)
    await db.broadcasts.update_one({"_id": job_id}, {"$set": {"status": "running", "total": total_msgs}})
    sent = 0
    failed = 0
    progress = []
    for i, contact in enumerate(contacts):
        # Stop if paused
        cur = await db.broadcasts.find_one({"_id": job_id})
        if cur and cur.get("status") == "paused":
            return
        if mode == "B":
            for s in senders:
                await asyncio.sleep(random.uniform(0.5, 1.2))  # simulated short delay for demo
                ok = random.random() > 0.05
                if ok:
                    sent += 1
                else:
                    failed += 1
                progress.append({"phone": contact["phone"], "sender": s.get("label", ""), "ok": ok, "ts": now_iso()})
        else:
            s = senders[i % len(senders)]
            await asyncio.sleep(random.uniform(0.5, 1.2))
            ok = random.random() > 0.05
            if ok:
                sent += 1
            else:
                failed += 1
            progress.append({"phone": contact["phone"], "sender": s.get("label", ""), "ok": ok, "ts": now_iso()})
        await db.broadcasts.update_one({"_id": job_id}, {"$set": {"sent": sent, "failed": failed, "progress": progress[-200:]}})
    await db.broadcasts.update_one({"_id": job_id}, {"$set": {"status": "done"}})

@api.post("/broadcast/start")
async def start_broadcast(payload: Dict[str, Any], background_tasks: BackgroundTasks):
    contacts = payload.get("contacts", [])
    if len(contacts) > 50:
        raise HTTPException(400, "Max 50 contacts per blast")
    job = BroadcastJob(
        id=new_id(),
        contacts=contacts,
        message=payload.get("message", ""),
        attachment_id=payload.get("attachment_id"),
        attachment_name=payload.get("attachment_name"),
        mode=payload.get("mode", "A"),
        total=len(contacts),
        created_at=now_iso(),
    ).model_dump()
    await db.broadcasts.insert_one({"_id": job["id"], **job})
    background_tasks.add_task(run_broadcast, job["id"])
    return job

@api.get("/broadcast/{job_id}")
async def get_broadcast(job_id: str):
    j = await db.broadcasts.find_one({"_id": job_id}, {"_id": 0})
    if not j:
        raise HTTPException(404)
    return j

@api.post("/broadcast/{job_id}/pause")
async def pause_broadcast(job_id: str):
    await db.broadcasts.update_one({"_id": job_id}, {"$set": {"status": "paused"}})
    return {"ok": True}

@api.get("/broadcast")
async def list_broadcasts():
    items = await db.broadcasts.find({}, {"_id": 0}).sort("created_at", -1).to_list(100)
    return items


# ============ SEED ============
async def seed_if_empty():
    # Settings
    if not await db.settings.find_one({"_id": "settings"}):
        await db.settings.insert_one({"_id": "settings", **Settings().model_dump()})

    # Templates
    existing = await db.templates.count_documents({})
    if existing == 0:
        for t in DEFAULT_TEMPLATES:
            await db.templates.insert_one({**t})

    # Catalog
    if await db.ranges.count_documents({}) == 0:
        ranges = ["Switches", "Fans", "LEDs", "MCBs", "Wires"]
        brands_per_range = ["Legrand", "Havells", "Anchor", "Schneider"]
        series_map = {
            "Legrand": ["Myrius", "Allzy", "Mylinc", "Arteor"],
            "Havells": ["Crabtree", "Coral", "Modular", "Reo"],
            "Anchor": ["Roma", "Penta", "Woods", "Ziva"],
            "Schneider": ["Livia", "ZenCelo", "Opale", "AvatarOn"],
        }
        for rname in ranges:
            r = ProductRange(id=new_id(), name=rname, brands=[]).model_dump()
            for bname in brands_per_range:
                brand = Brand(id=new_id(), name=bname, series=[]).model_dump()
                for sname in series_map.get(bname, ["Standard"]):
                    brand["series"].append(Series(id=new_id(), name=sname).model_dump())
                r["brands"].append(brand)
            await db.ranges.insert_one({"_id": r["id"], **r})

    # Seed 2 senders
    if await db.senders.count_documents({}) == 0:
        for i, label in enumerate(["Sender 1 (Jio)", "Sender 2 (Airtel)"]):
            s = Sender(id=new_id(), label=label, phone="", status="Disconnected").model_dump()
            await db.senders.insert_one({"_id": s["id"], **s})


@app.on_event("startup")
async def on_startup():
    await seed_if_empty()
    logger.info("Veer Electrical backend started, seed complete")

@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()


# Health
@api.get("/")
async def root():
    return {"ok": True, "service": "Veer Electrical"}


app.include_router(api)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=os.environ.get('CORS_ORIGINS', '*').split(','),
    allow_methods=["*"],
    allow_headers=["*"],
)
