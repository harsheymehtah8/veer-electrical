from fastapi import FastAPI, APIRouter, HTTPException, UploadFile, File, Form, Header, BackgroundTasks
from fastapi.responses import FileResponse, StreamingResponse, Response
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os
import io
import re
import random
import asyncio
import logging
import requests
from pathlib import Path
from pydantic import BaseModel, Field, ConfigDict
from typing import List, Optional, Dict, Any, Tuple
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


# ============ PERSISTENT OBJECT STORAGE (Emergent) ============
# Files uploaded here survive redeploys, unlike /app/backend/uploads which is ephemeral.
STORAGE_URL = "https://integrations.emergentagent.com/objstore/api/v1/storage"
EMERGENT_KEY = os.environ.get("EMERGENT_LLM_KEY")
APP_NAME = "veer-electrical"
_storage_key: Optional[str] = None

MIME_TYPES = {
    "jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png",
    "gif": "image/gif", "webp": "image/webp", "pdf": "application/pdf",
    "mp4": "video/mp4", "mov": "video/quicktime", "3gp": "video/3gpp",
    "mp3": "audio/mpeg", "ogg": "audio/ogg", "wav": "audio/wav", "m4a": "audio/mp4",
    "json": "application/json", "csv": "text/csv", "txt": "text/plain",
}


def init_storage() -> Optional[str]:
    """Initialise once; reuse storage_key for subsequent put/get calls."""
    global _storage_key
    if _storage_key:
        return _storage_key
    if not EMERGENT_KEY:
        logger.warning("EMERGENT_LLM_KEY not set — falling back to local disk storage (not persistent)")
        return None
    try:
        r = requests.post(f"{STORAGE_URL}/init", json={"emergent_key": EMERGENT_KEY}, timeout=30)
        r.raise_for_status()
        _storage_key = r.json()["storage_key"]
        logger.info("✅ Emergent object storage initialised")
        return _storage_key
    except Exception as e:
        logger.error(f"Storage init failed: {e}")
        return None


def put_object(path: str, data: bytes, content_type: str) -> Optional[Dict[str, Any]]:
    key = init_storage()
    if not key:
        return None
    try:
        r = requests.put(
            f"{STORAGE_URL}/objects/{path}",
            headers={"X-Storage-Key": key, "Content-Type": content_type},
            data=data, timeout=120,
        )
        if r.status_code == 403:
            # Stale key — re-init once and retry
            global _storage_key
            _storage_key = None
            key = init_storage()
            if key:
                r = requests.put(
                    f"{STORAGE_URL}/objects/{path}",
                    headers={"X-Storage-Key": key, "Content-Type": content_type},
                    data=data, timeout=120,
                )
        r.raise_for_status()
        return r.json()
    except Exception as e:
        logger.error(f"put_object({path}) failed: {e}")
        return None


def get_object(path: str) -> Optional[Tuple[bytes, str]]:
    key = init_storage()
    if not key:
        return None
    try:
        r = requests.get(
            f"{STORAGE_URL}/objects/{path}",
            headers={"X-Storage-Key": key}, timeout=60,
        )
        if r.status_code == 403:
            global _storage_key
            _storage_key = None
            key = init_storage()
            if key:
                r = requests.get(f"{STORAGE_URL}/objects/{path}", headers={"X-Storage-Key": key}, timeout=60)
        r.raise_for_status()
        return r.content, r.headers.get("Content-Type", "application/octet-stream")
    except Exception as e:
        logger.error(f"get_object({path}) failed: {e}")
        return None


async def save_uploaded_file(file: UploadFile) -> Dict[str, Any]:
    """Save an UploadFile to persistent storage with local-disk fallback.
    Returns the file metadata dict to store in MongoDB.
    """
    file_id = new_id()
    filename = file.filename or f"upload-{file_id}"
    ext = (Path(filename).suffix.lstrip(".") or "bin").lower()
    content = await file.read()
    content_type = file.content_type or MIME_TYPES.get(ext, "application/octet-stream")

    storage_path = f"{APP_NAME}/uploads/{file_id}.{ext}"
    result = put_object(storage_path, content, content_type)

    meta: Dict[str, Any] = {
        "_id": file_id,
        "filename": filename,
        "content_type": content_type,
        "size": len(content),
        "uploaded_at": now_iso(),
    }
    if result and result.get("path"):
        meta["storage_path"] = result["path"]
    else:
        # Fallback: write to local disk so dev/preview still works without keys
        save_path = UPLOAD_DIR / f"{file_id}.{ext}"
        save_path.write_bytes(content)
        meta["path"] = str(save_path)
    return meta


async def load_file_bytes(rec: Dict[str, Any]) -> Optional[Tuple[bytes, str]]:
    """Return (bytes, content_type) for a file record, trying persistent storage first."""
    sp = rec.get("storage_path")
    if sp:
        got = get_object(sp)
        if got:
            return got
    # Legacy local-disk path
    p = rec.get("path")
    if p:
        path_obj = Path(p)
        if path_obj.exists():
            ct = rec.get("content_type") or "application/octet-stream"
            return path_obj.read_bytes(), ct
    return None


@app.on_event("startup")
async def _startup_init_storage():
    init_storage()
    # Indexes for fast search across 40k+ contacts
    try:
        await db.contacts.create_index("mobile", unique=False, sparse=True)
        await db.contacts.create_index("source")
        await db.contacts.create_index("created_at")
        await db.contacts.create_index([("name", 1)])
        await db.contacts.create_index([("shop_name", 1)])
        await db.contacts.create_index([("city", 1)])
        await db.contacts.create_index([("state", 1)])
        await db.outbox.create_index("status")
        await db.outbox.create_index("sender_id")
        await db.outbox.create_index("broadcast_id")
        await db.outbox.create_index("created_at")
        logger.info("✅ MongoDB indexes ensured")
    except Exception as e:
        logger.error(f"Index create failed: {e}")


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
    webhook_secret: str = Field(default_factory=lambda: uuid.uuid4().hex)
    bot_enabled: bool = True

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
    status: str = "Healthy"  # Healthy, Caution, Risk, Disconnected
    daily_sent: int = 0
    daily_cap: int = 50
    last_seen: Optional[str] = None
    online: bool = False

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

@api.post("/settings/bot-toggle")
async def toggle_bot(payload: Dict[str, bool]):
    enabled = bool(payload.get("enabled", True))
    await db.settings.update_one({"_id": "settings"}, {"$set": {"bot_enabled": enabled}}, upsert=True)
    return {"bot_enabled": enabled}

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
    meta = await save_uploaded_file(file)
    await db.files.insert_one(meta)
    file_id = meta["_id"]
    # Update series in catalog
    range_doc = await db.ranges.find_one({"_id": range_id})
    if not range_doc:
        raise HTTPException(404, "Range not found")
    for brand in range_doc.get("brands", []):
        if brand["id"] == brand_id:
            for s in brand.get("series", []):
                if s["id"] == series_id:
                    s["pdf_id"] = file_id
                    s["pdf_filename"] = meta["filename"]
    await db.ranges.update_one({"_id": range_id}, {"$set": {"brands": range_doc["brands"]}})
    return {"file_id": file_id, "filename": meta["filename"]}

@api.get("/files/{file_id}")
async def serve_file(file_id: str):
    rec = await db.files.find_one({"_id": file_id})
    if not rec:
        raise HTTPException(404)
    got = await load_file_bytes(rec)
    if not got:
        raise HTTPException(404, "File data missing")
    data, content_type = got
    filename = rec.get("filename", "file")
    return Response(
        content=data,
        media_type=content_type,
        headers={"Content-Disposition": f'inline; filename="{filename}"'},
    )

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

# ============ CONTACTS (Address Book) ============
class Contact(BaseModel):
    id: str
    name: str = ""
    shop_name: str = ""
    mobile: str = ""
    city: str = ""
    district: str = ""
    state: str = ""
    source: str = "manual"  # manual, imported, bot
    created_at: str
    updated_at: str

def normalize_phone(raw: str) -> str:
    """Normalize Indian phone numbers — always returns digits only with 91 prefix.
    Examples: 9876543210 -> 919876543210, +91 98765-43210 -> 919876543210, 09876543210 -> 919876543210.
    """
    if not raw:
        return ""
    digits = re.sub(r'\D', '', str(raw))
    # Strip Indian leading 0
    if digits.startswith("0") and len(digits) == 11:
        digits = digits[1:]
    # Already has 91 prefix
    if digits.startswith("91") and len(digits) >= 12:
        return digits
    # 10-digit Indian number — add 91
    if len(digits) == 10:
        return "91" + digits
    return digits

@api.get("/contacts")
async def list_contacts(q: Optional[str] = None, source: Optional[str] = None,
                        city: Optional[str] = None, state: Optional[str] = None,
                        limit: int = 200, skip: int = 0):
    # Cap server-side to keep responses snappy even with 40k+ contacts.
    # UI is responsible for narrowing via q/source/skip.
    limit = max(1, min(limit, 500))
    skip = max(0, skip)
    query: Dict[str, Any] = {}
    if source:
        query["source"] = source
    if city:
        query["city"] = {"$regex": city, "$options": "i"}
    if state:
        query["state"] = {"$regex": state, "$options": "i"}
    if q:
        digits = re.sub(r'\D', '', q)
        non_digit = re.sub(r'\d', '', q).strip()
        qx = re.escape(q)
        or_clauses = [
            {"name": {"$regex": qx, "$options": "i"}},
            {"shop_name": {"$regex": qx, "$options": "i"}},
            {"city": {"$regex": qx, "$options": "i"}},
            {"district": {"$regex": qx, "$options": "i"}},
            {"state": {"$regex": qx, "$options": "i"}},
        ]
        # Only search mobile if input looks like a phone number (mostly digits, 4+ digits, no significant text)
        if digits and len(digits) >= 4 and len(non_digit) <= 2:
            or_clauses.append({"mobile": {"$regex": digits}})
        query["$or"] = or_clauses
    total = await db.contacts.count_documents(query)
    items = await db.contacts.find(query, {"_id": 0}).sort("created_at", -1).skip(skip).limit(limit).to_list(limit)
    return {"total": total, "items": items}

@api.get("/contacts/stats")
async def contacts_stats():
    total = await db.contacts.count_documents({})
    by_source = {}
    async for r in db.contacts.aggregate([{"$group": {"_id": "$source", "count": {"$sum": 1}}}]):
        by_source[r["_id"] or "unknown"] = r["count"]
    return {"total": total, "by_source": by_source}

@api.post("/contacts")
async def create_contact(payload: Dict[str, str]):
    mobile = normalize_phone(payload.get("mobile", ""))
    if not mobile:
        raise HTTPException(400, "Mobile number required")
    # Dedup by mobile
    existing = await db.contacts.find_one({"mobile": mobile})
    if existing:
        await db.contacts.update_one({"id": existing["id"]}, {"$set": {
            "name": payload.get("name", existing.get("name", "")),
            "shop_name": payload.get("shop_name", existing.get("shop_name", "")),
            "city": payload.get("city", existing.get("city", "")),
            "district": payload.get("district", existing.get("district", "")),
            "state": payload.get("state", existing.get("state", "")),
            "updated_at": now_iso(),
        }})
        return {"id": existing["id"], "merged": True}
    c = Contact(
        id=new_id(),
        name=payload.get("name", "").strip(),
        shop_name=payload.get("shop_name", "").strip(),
        mobile=mobile,
        city=payload.get("city", "").strip(),
        district=payload.get("district", "").strip(),
        state=payload.get("state", "").strip(),
        source=payload.get("source", "manual"),
        created_at=now_iso(),
        updated_at=now_iso(),
    ).model_dump()
    await db.contacts.insert_one(c)
    c.pop("_id", None)
    return c

@api.put("/contacts/{contact_id}")
async def update_contact(contact_id: str, payload: Dict[str, str]):
    update = {k: v.strip() if isinstance(v, str) else v for k, v in payload.items()
              if k in ["name", "shop_name", "city", "district", "state"]}
    if "mobile" in payload:
        update["mobile"] = normalize_phone(payload["mobile"])
    update["updated_at"] = now_iso()
    await db.contacts.update_one({"id": contact_id}, {"$set": update})
    return {"ok": True}

@api.delete("/contacts/{contact_id}")
async def delete_contact(contact_id: str):
    await db.contacts.delete_one({"id": contact_id})
    return {"ok": True}

# ---- Excel/CSV Import ----
@api.post("/contacts/import/preview")
async def import_preview(file: UploadFile = File(...)):
    """Returns column headers + first 5 sample rows so user can map columns."""
    content = await file.read()
    try:
        if file.filename.lower().endswith((".xlsx", ".xls")):
            df = pd.read_excel(io.BytesIO(content), dtype=str).fillna("")
        else:
            df = pd.read_csv(io.BytesIO(content), dtype=str).fillna("")
    except Exception as e:
        raise HTTPException(400, f"Failed to parse file: {e}")
    columns = [str(c) for c in df.columns]
    sample = df.head(5).to_dict(orient="records")
    # Stash file in db for commit step
    file_id = new_id()
    await db.import_staging.insert_one({
        "_id": file_id,
        "filename": file.filename,
        "columns": columns,
        "rows": df.fillna("").astype(str).to_dict(orient="records"),
        "created_at": now_iso(),
    })
    return {
        "file_id": file_id,
        "columns": columns,
        "sample": sample,
        "total_rows": len(df),
    }

@api.post("/contacts/import/commit")
async def import_commit(payload: Dict[str, Any]):
    """User submits column mapping; backend imports all rows."""
    file_id = payload.get("file_id")
    mapping = payload.get("mapping", {})  # {field: column_name}
    if not file_id:
        raise HTTPException(400, "file_id required")
    staged = await db.import_staging.find_one({"_id": file_id})
    if not staged:
        raise HTTPException(404, "Import file not found or expired")
    rows = staged.get("rows", [])
    # Tag every imported contact with the original filename so the user can later
    # bulk-delete by file (e.g. delete everything from "telangana.xlsx").
    batch_name = staged.get("filename") or f"import-{file_id[:8]}"
    inserted = 0
    merged = 0
    skipped = 0
    for row in rows:
        def col_val(field: str) -> str:
            return str(row.get(mapping.get(field) or "", "")).strip()
        mobile = normalize_phone(col_val("mobile"))
        if not mobile or len(mobile) < 10:
            skipped += 1
            continue
        existing = await db.contacts.find_one({"mobile": mobile})
        contact_data = {
            "name": col_val("name"),
            "shop_name": col_val("shop_name"),
            "mobile": mobile,
            "city": col_val("city"),
            "district": col_val("district"),
            "state": col_val("state"),
            "source": "imported",
            "import_batch": batch_name,
            "updated_at": now_iso(),
        }
        if existing:
            # Don't overwrite an existing batch tag — keep the first one
            update_data = {k: v for k, v in contact_data.items() if v}
            if existing.get("import_batch"):
                update_data.pop("import_batch", None)
            await db.contacts.update_one({"id": existing["id"]}, {"$set": update_data})
            merged += 1
        else:
            contact_data["id"] = new_id()
            contact_data["created_at"] = now_iso()
            await db.contacts.insert_one(contact_data)
            inserted += 1
    # Cleanup staged file
    await db.import_staging.delete_one({"_id": file_id})
    return {"inserted": inserted, "merged": merged, "skipped": skipped, "total": len(rows), "batch": batch_name}

@api.get("/contacts/import-batches")
async def list_import_batches():
    """List all distinct import batches (filenames) with counts.
    Lets the UI offer 'Delete everything from telangana.xlsx'.
    """
    pipeline = [
        {"$match": {"source": "imported", "import_batch": {"$exists": True, "$ne": None, "$nin": ["", None]}}},
        {"$group": {"_id": "$import_batch", "count": {"$sum": 1}}},
        {"$sort": {"count": -1}},
        {"$limit": 100},
    ]
    rows = await db.contacts.aggregate(pipeline).to_list(100)
    return [{"name": r["_id"], "count": r["count"]} for r in rows]


def _build_bulk_filter(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Translate the bulk-delete payload into a MongoDB filter."""
    f: Dict[str, Any] = {}
    if payload.get("source"):
        f["source"] = payload["source"]
    if payload.get("import_batch"):
        f["import_batch"] = payload["import_batch"]
    if payload.get("city"):
        f["city"] = {"$regex": f"^{re.escape(payload['city'].strip())}$", "$options": "i"}
    if payload.get("state"):
        f["state"] = {"$regex": f"^{re.escape(payload['state'].strip())}$", "$options": "i"}
    if payload.get("district"):
        f["district"] = {"$regex": f"^{re.escape(payload['district'].strip())}$", "$options": "i"}
    return f


@api.post("/contacts/bulk-delete/preview")
async def bulk_delete_preview(payload: Dict[str, Any]):
    """Returns count + sample (first 5) of what would be deleted. Safety net before commit."""
    f = _build_bulk_filter(payload)
    if not f:
        raise HTTPException(400, "At least one filter required (state/city/import_batch/source)")
    count = await db.contacts.count_documents(f)
    samples = await db.contacts.find(f, {"_id": 0, "name": 1, "shop_name": 1, "mobile": 1, "city": 1, "state": 1}).limit(5).to_list(5)
    return {"count": count, "samples": samples, "filter": f}


@api.post("/contacts/bulk-delete/commit")
async def bulk_delete_commit(payload: Dict[str, Any]):
    """Actually deletes contacts matching the filter. Same filter shape as preview."""
    f = _build_bulk_filter(payload)
    if not f:
        raise HTTPException(400, "At least one filter required")
    # Require an explicit confirm flag to prevent accidental {} deletes
    if not payload.get("confirm"):
        raise HTTPException(400, "confirm:true required")
    res = await db.contacts.delete_many(f)
    return {"deleted": res.deleted_count}


@api.get("/contacts/export")
async def export_contacts():
    contacts = await db.contacts.find({}, {"_id": 0}).sort("created_at", -1).to_list(50000)
    df = pd.DataFrame(contacts)
    if df.empty:
        df = pd.DataFrame(columns=["name", "shop_name", "mobile", "city", "district", "state", "source", "created_at"])
    else:
        df = df[["name", "shop_name", "mobile", "city", "district", "state", "source", "created_at"]]
    buf = io.BytesIO()
    df.to_excel(buf, index=False, engine='openpyxl')
    buf.seek(0)
    return StreamingResponse(buf, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                             headers={"Content-Disposition": "attachment; filename=contacts.xlsx"})

async def upsert_contact_from_bot(phone: str, party_name: str, city: str, state: str):
    """Called by bot when a lead is captured — keeps contacts table in sync.
    If a contact already exists (imported/manual), only the source tag is upgraded to 'bot'
    and existing fields are preserved unless empty. Never overwrites already-set values.
    """
    mobile = normalize_phone(phone)
    if not mobile:
        return
    existing = await db.contacts.find_one({"mobile": mobile})
    if existing:
        update_set = {"source": "bot", "updated_at": now_iso()}
        # Only fill blanks — never overwrite already-set fields
        if not (existing.get("name") or "").strip() and party_name:
            update_set["name"] = party_name
        if not (existing.get("city") or "").strip() and city:
            update_set["city"] = city
        if not (existing.get("state") or "").strip() and state:
            update_set["state"] = state
        await db.contacts.update_one({"id": existing["id"]}, {"$set": update_set})
    else:
        c = Contact(
            id=new_id(),
            name=party_name,
            shop_name="",
            mobile=mobile,
            city=city,
            district="",
            state=state,
            source="bot",
            created_at=now_iso(),
            updated_at=now_iso(),
        ).model_dump()
        await db.contacts.insert_one(c)

# ============ BLAST TEMPLATES (saved outgoing message drafts) ============
@api.get("/blast-templates")
async def list_blast_templates(q: Optional[str] = None):
    query: Dict[str, Any] = {}
    if q:
        rx = {"$regex": re.escape(q), "$options": "i"}
        query["$or"] = [{"name": rx}, {"message": rx}, {"attachment_name": rx}]
    items = await db.blast_templates.find(query, {"_id": 0}).sort("created_at", -1).to_list(500)
    return items

@api.post("/blast-templates")
async def create_blast_template(payload: Dict[str, Any]):
    name = (payload.get("name") or "").strip()
    if not name:
        raise HTTPException(400, "Template name required")
    doc = {
        "id": new_id(),
        "name": name,
        "message": payload.get("message", ""),
        "attachment_id": payload.get("attachment_id"),
        "attachment_name": payload.get("attachment_name"),
        "created_at": now_iso(),
        "updated_at": now_iso(),
    }
    await db.blast_templates.insert_one(doc)
    doc.pop("_id", None)
    return doc

@api.put("/blast-templates/{tid}")
async def update_blast_template(tid: str, payload: Dict[str, Any]):
    update = {k: v for k, v in payload.items()
             if k in ["name", "message", "attachment_id", "attachment_name"]}
    update["updated_at"] = now_iso()
    await db.blast_templates.update_one({"id": tid}, {"$set": update})
    return {"ok": True}

@api.delete("/blast-templates/{tid}")
async def delete_blast_template(tid: str):
    await db.blast_templates.delete_one({"id": tid})
    return {"ok": True}

# ============ GROUPS (contact groups for blasts) ============
GROUP_CAP = 50

@api.get("/groups")
async def list_groups(q: Optional[str] = None):
    query: Dict[str, Any] = {}
    if q:
        query["name"] = {"$regex": re.escape(q), "$options": "i"}
    items = await db.groups.find(query, {"_id": 0}).sort("created_at", -1).to_list(500)
    # add count + pop heavy contact_ids if not needed (keep ids for badge)
    for g in items:
        g["count"] = len(g.get("contact_ids") or [])
    return items

@api.get("/groups/{gid}")
async def get_group(gid: str):
    g = await db.groups.find_one({"id": gid}, {"_id": 0})
    if not g:
        raise HTTPException(404, "Group not found")
    contact_ids = g.get("contact_ids") or []
    contacts = await db.contacts.find({"id": {"$in": contact_ids}}, {"_id": 0}).to_list(500)
    g["contacts"] = contacts
    g["count"] = len(contact_ids)
    return g

@api.post("/groups")
async def create_group(payload: Dict[str, Any]):
    name = (payload.get("name") or "").strip()
    if not name:
        raise HTTPException(400, "Group name required")
    contact_ids = payload.get("contact_ids") or []
    if len(contact_ids) > GROUP_CAP:
        raise HTTPException(400, f"Max {GROUP_CAP} contacts per group")
    doc = {
        "id": new_id(),
        "name": name,
        "contact_ids": list(dict.fromkeys(contact_ids))[:GROUP_CAP],  # dedupe + cap
        "created_at": now_iso(),
        "updated_at": now_iso(),
    }
    await db.groups.insert_one(doc)
    doc.pop("_id", None)
    doc["count"] = len(doc["contact_ids"])
    return doc

@api.put("/groups/{gid}")
async def update_group(gid: str, payload: Dict[str, Any]):
    update: Dict[str, Any] = {"updated_at": now_iso()}
    if "name" in payload and payload["name"]:
        update["name"] = payload["name"].strip()
    await db.groups.update_one({"id": gid}, {"$set": update})
    return {"ok": True}

@api.post("/groups/{gid}/contacts")
async def add_to_group(gid: str, payload: Dict[str, Any]):
    add_ids = payload.get("contact_ids") or []
    g = await db.groups.find_one({"id": gid})
    if not g:
        raise HTTPException(404, "Group not found")
    current = g.get("contact_ids") or []
    merged = list(dict.fromkeys(current + add_ids))
    if len(merged) > GROUP_CAP:
        raise HTTPException(400, f"Max {GROUP_CAP} contacts per group (would be {len(merged)})")
    await db.groups.update_one({"id": gid}, {"$set": {"contact_ids": merged, "updated_at": now_iso()}})
    return {"count": len(merged)}

@api.delete("/groups/{gid}/contacts/{cid}")
async def remove_from_group(gid: str, cid: str):
    await db.groups.update_one({"id": gid}, {"$pull": {"contact_ids": cid}, "$set": {"updated_at": now_iso()}})
    return {"ok": True}

@api.delete("/groups/{gid}")
async def delete_group(gid: str):
    await db.groups.delete_one({"id": gid})
    return {"ok": True}

@api.get("/groups/{gid}/history")
async def group_blast_history(gid: str, limit: int = 50):
    """Returns the past blasts that were sent to this group (most recent first)."""
    items = await db.broadcasts.find(
        {"group_id": gid},
        {"_id": 0, "id": 1, "total": 1, "sent": 1, "failed": 1, "status": 1,
         "message": 1, "attachment_name": 1, "created_at": 1, "mode": 1},
    ).sort("created_at", -1).to_list(limit)
    return items

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

async def bot_process(phone: str, message: str, enforce_blast_filter: bool = False) -> List[Dict[str, Any]]:
    """Returns list of bot replies. Each reply: {type: 'text'|'pdf', text/file_id/filename}"""
    msg = (message or "").strip()
    msg_lower = msg.lower()
    replies: List[Dict[str, Any]] = []
    settings = await db.settings.find_one({"_id": "settings"}, {"_id": 0}) or Settings().model_dump()
    prefix = settings.get("prefix_tag", "VE")

    # MASTER KILL SWITCH — owner can pause the bot entirely from dashboard
    if enforce_blast_filter and settings.get("bot_enabled", True) is False:
        return replies

    state = await get_state(phone)
    lead = await existing_lead(phone)

    # GATEKEEPER: only engage with cold-blast recipients (or already-saved leads).
    # Random unknown numbers messaging us first are silently ignored.
    if enforce_blast_filter and not lead:
        was_blasted = await db.blasted_contacts.find_one({"_id": phone})
        if not was_blasted:
            return replies  # silent

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
        # Also save in contacts address book
        await upsert_contact_from_bot(phone, firm, city, st)
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

# ============ WHATSAPP WORKER (Baileys VPS) ============
async def get_secret() -> str:
    s = await db.settings.find_one({"_id": "settings"}, {"_id": 0})
    return (s or {}).get("webhook_secret", "")

async def require_worker_secret(x_webhook_secret: Optional[str] = Header(None)):
    expected = await get_secret()
    if not expected or x_webhook_secret != expected:
        raise HTTPException(status_code=401, detail="Invalid webhook secret")
    return True

async def queue_outbox(phone: str, payload: Dict[str, Any], sender_id: Optional[str] = None):
    # If no sender specified, pick the first online/registered sender
    if not sender_id:
        s = await db.senders.find_one({"online": True}, {"_id": 0}) or await db.senders.find_one({}, {"_id": 0})
        sender_id = s["id"] if s else "default"
    doc = {
        "_id": new_id(),
        "phone": phone,
        "payload": payload,
        "sender_id": sender_id,
        "status": "pending",
        "created_at": now_iso(),
    }
    await db.outbox.insert_one(doc)

@api.get("/whitelist")
async def list_whitelist():
    items = await db.blasted_contacts.find({}).sort("last_blasted_at", -1).to_list(2000)
    return {"count": len(items), "phones": [{"phone": i["_id"], "first_blasted_at": i.get("first_blasted_at"), "last_blasted_at": i.get("last_blasted_at")} for i in items]}

@api.post("/whitelist")
async def add_whitelist(payload: Dict[str, str]):
    phone = re.sub(r'\D', '', payload.get("phone", ""))
    if not phone:
        raise HTTPException(400, "Phone required")
    await db.blasted_contacts.update_one(
        {"_id": phone},
        {"$set": {"last_blasted_at": now_iso()}, "$setOnInsert": {"first_blasted_at": now_iso(), "manual": True}},
        upsert=True,
    )
    return {"ok": True, "phone": phone}

@api.delete("/whitelist/{phone}")
async def remove_whitelist(phone: str):
    await db.blasted_contacts.delete_one({"_id": phone})
    return {"ok": True}

@api.post("/whatsapp/register")
async def whatsapp_register(body: Dict[str, str], x_webhook_secret: Optional[str] = Header(None)):
    """Worker calls this after QR scan to announce its phone number for its sender_id."""
    expected = await get_secret()
    if not expected or x_webhook_secret != expected:
        raise HTTPException(status_code=401, detail="Invalid webhook secret")
    sender_id = body.get("sender_id") or "default"
    phone = body.get("phone") or ""
    label = body.get("label") or f"Sender ({phone[-4:]})" if phone else f"Sender {sender_id}"
    await db.senders.update_one(
        {"_id": sender_id},
        {"$set": {
            "id": sender_id, "phone": phone, "label": label,
            "status": "Healthy", "online": True, "last_seen": now_iso(),
        }, "$setOnInsert": {"daily_sent": 0, "daily_cap": 50}},
        upsert=True,
    )
    return {"ok": True, "sender_id": sender_id}

@api.post("/whatsapp/incoming")
async def whatsapp_incoming(body: Dict[str, Any], x_webhook_secret: Optional[str] = Header(None)):
    """Called by Baileys worker when a customer sends a message."""
    expected = await get_secret()
    if not expected or x_webhook_secret != expected:
        raise HTTPException(status_code=401, detail="Invalid webhook secret")
    phone = body.get("phone", "")
    message = body.get("message", "")
    received_by = body.get("sender_id") or "default"
    replies = await bot_process(phone, message, enforce_blast_filter=True)
    # Determine which sender should reply: the one who originally blasted them (if known), else the receiver
    bc = await db.blasted_contacts.find_one({"_id": phone})
    reply_sender = (bc or {}).get("sender_id") or received_by
    for r in replies:
        await queue_outbox(phone, r, sender_id=reply_sender)
    # Sender heartbeat
    await db.senders.update_one(
        {"_id": received_by},
        {"$set": {"last_seen": now_iso(), "online": True}},
        upsert=True,
    )
    return {"queued": len(replies), "reply_sender": reply_sender}

@api.get("/whatsapp/outbox")
async def whatsapp_outbox(
    x_webhook_secret: Optional[str] = Header(None),
    sender_id: Optional[str] = None,
    limit: int = 20,
):
    """Baileys worker polls this every ~2s for messages tagged for its sender_id."""
    expected = await get_secret()
    if not expected or x_webhook_secret != expected:
        raise HTTPException(status_code=401, detail="Invalid webhook secret")
    sid = sender_id or "default"
    # Auto-register sender if first time we're seeing it (handles v1 workers w/o /register)
    await db.senders.update_one(
        {"_id": sid},
        {"$set": {"id": sid, "last_seen": now_iso(), "online": True},
         "$setOnInsert": {"label": f"Sender {sid}", "phone": "", "status": "Healthy", "daily_sent": 0, "daily_cap": 50}},
        upsert=True,
    )
    # Backward compat: when polling as 'default', also pick up old docs that had no sender_id
    if sid == "default":
        query = {"status": "pending", "$or": [{"sender_id": "default"}, {"sender_id": {"$exists": False}}]}
    else:
        query = {"status": "pending", "sender_id": sid}
    items = await db.outbox.find(
        query,
        {"_id": 1, "phone": 1, "payload": 1, "created_at": 1, "sender_id": 1, "broadcast_id": 1},
    ).sort("created_at", 1).to_list(limit)
    ids = [i["_id"] for i in items]
    if ids:
        await db.outbox.update_many({"_id": {"$in": ids}}, {"$set": {"status": "sending"}})
    return {"messages": [
        {
            "id": i["_id"],
            "phone": i["phone"],
            "payload": i["payload"],
            "broadcast_id": i.get("broadcast_id"),  # so worker can apply 8–25s anti-ban delay
        }
        for i in items
    ]}

@api.post("/whatsapp/ack")
async def whatsapp_ack(body: Dict[str, Any], x_webhook_secret: Optional[str] = Header(None)):
    """Worker confirms which outbox messages were sent or failed.
    `failed` accepts either ["id"] (legacy) or [{"id": "...", "reason": "..."}] (preferred).
    """
    expected = await get_secret()
    if not expected or x_webhook_secret != expected:
        raise HTTPException(status_code=401, detail="Invalid webhook secret")
    sent_ids = body.get("sent", [])
    raw_failed = body.get("failed", [])
    sender_id = body.get("sender_id")
    # Normalize failed entries -> list of (id, reason)
    failed_pairs: List[tuple] = []
    for f in raw_failed:
        if isinstance(f, dict):
            fid = f.get("id")
            reason = (f.get("reason") or "").strip()[:300]
            if fid:
                failed_pairs.append((fid, reason))
        elif isinstance(f, str):
            failed_pairs.append((f, ""))
    failed_ids = [fid for fid, _ in failed_pairs]
    if sent_ids:
        await db.outbox.update_many({"_id": {"$in": sent_ids}}, {"$set": {"status": "sent", "sent_at": now_iso()}})
        if sender_id:
            await db.senders.update_one({"_id": sender_id}, {"$inc": {"daily_sent": len(sent_ids)}})
        for sid in sent_ids:
            doc = await db.outbox.find_one({"_id": sid}, {"broadcast_id": 1})
            if doc and doc.get("broadcast_id"):
                await db.broadcasts.update_one({"_id": doc["broadcast_id"]}, {"$inc": {"sent": 1}})
    if failed_pairs:
        # Per-message reason update (one update per item to preserve reason)
        for fid, reason in failed_pairs:
            await db.outbox.update_one(
                {"_id": fid},
                {"$set": {"status": "failed", "failed_at": now_iso(), "error_reason": reason or "send failed"}},
            )
        for sid in failed_ids:
            doc = await db.outbox.find_one({"_id": sid}, {"broadcast_id": 1})
            if doc and doc.get("broadcast_id"):
                await db.broadcasts.update_one({"_id": doc["broadcast_id"]}, {"$inc": {"failed": 1}})
    return {"ok": True}

@api.get("/whatsapp/queue/stats")
async def queue_stats():
    """Counts of pending/sending/sent/failed messages, plus per-sender breakdown."""
    pipeline = [
        {"$group": {"_id": {"sender": "$sender_id", "status": "$status"}, "count": {"$sum": 1}}},
    ]
    rows = await db.outbox.aggregate(pipeline).to_list(1000)
    by_sender = {}
    totals = {"pending": 0, "sending": 0, "sent": 0, "failed": 0}
    for r in rows:
        sender = (r["_id"].get("sender") or "default")
        status = r["_id"].get("status")
        by_sender.setdefault(sender, {"pending": 0, "sending": 0, "sent": 0, "failed": 0})
        if status in by_sender[sender]:
            by_sender[sender][status] = r["count"]
            totals[status] = totals.get(status, 0) + r["count"]
    return {"totals": totals, "by_sender": by_sender}

@api.get("/whatsapp/queue/recent")
async def queue_recent(limit: int = 50):
    """Most recent outbox entries across all statuses."""
    items = await db.outbox.find(
        {},
        {"_id": 1, "phone": 1, "payload": 1, "sender_id": 1, "status": 1, "created_at": 1, "sent_at": 1, "failed_at": 1, "broadcast_id": 1, "error_reason": 1},
    ).sort("created_at", -1).to_list(limit)
    out = []
    for it in items:
        p = it.get("payload") or {}
        out.append({
            "id": it["_id"],
            "phone": it.get("phone"),
            "sender_id": it.get("sender_id"),
            "status": it.get("status"),
            "type": p.get("type"),
            "preview": (p.get("text") or p.get("filename") or "")[:80],
            "created_at": it.get("created_at"),
            "sent_at": it.get("sent_at"),
            "failed_at": it.get("failed_at"),
            "broadcast_id": it.get("broadcast_id"),
            "error_reason": it.get("error_reason"),
        })
    return out

@api.get("/whatsapp/worker-status")
async def worker_status():
    """Aggregate status across all senders."""
    senders = await db.senders.find({}, {"_id": 0}).to_list(50)
    any_online = False
    for s in senders:
        ls = s.get("last_seen")
        if ls:
            try:
                ts = datetime.fromisoformat(ls.replace("Z", "+00:00"))
                if (datetime.now(timezone.utc) - ts).total_seconds() < 30:
                    any_online = True
                    break
            except Exception:
                pass
    last_seen = max([s.get("last_seen") for s in senders if s.get("last_seen")], default=None)
    return {"online": any_online, "last_seen": last_seen, "sender_count": len(senders)}

@api.post("/whatsapp/queue/cancel-pending")
async def cancel_pending_queue():
    """Cancel all pending messages in the outbox.
    Marks them as 'cancelled' so workers won't pick them up.
    Already-sent or in-flight messages are not affected.
    """
    res = await db.outbox.update_many(
        {"status": {"$in": ["pending", "sending"]}},
        {"$set": {"status": "cancelled", "cancelled_at": now_iso(), "error_reason": "Cancelled by user"}},
    )
    # Also mark any 'running' broadcasts as cancelled
    await db.broadcasts.update_many(
        {"status": {"$in": ["running", "queued_to_workers"]}},
        {"$set": {"status": "cancelled", "cancelled_at": now_iso()}},
    )
    return {"cancelled": res.modified_count}


@api.post("/whatsapp/queue/retry-failed")
async def retry_failed():
    """Re-queue all failed messages back to 'pending' so workers retry them."""
    res = await db.outbox.update_many(
        {"status": "failed"},
        {"$set": {"status": "pending", "retried_at": now_iso()}, "$unset": {"error_reason": "", "failed_at": ""}},
    )
    return {"retried": res.modified_count}


@api.post("/whatsapp/queue/clear-history")
async def clear_queue_history():
    """Delete completed queue records (sent + failed + cancelled).
    Active rows (pending, sending) are kept so an in-progress blast isn't disrupted.
    """
    res = await db.outbox.delete_many({"status": {"$in": ["sent", "failed", "cancelled"]}})
    return {"deleted": res.deleted_count}

@api.post("/whatsapp/regenerate-secret")
async def regenerate_secret():
    new_secret = uuid.uuid4().hex
    await db.settings.update_one({"_id": "settings"}, {"$set": {"webhook_secret": new_secret}})
    return {"webhook_secret": new_secret}

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
                phone = normalize_phone(val)
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
                phone = normalize_phone(p)
            elif p and not name:
                name = p
        if phone:
            contacts.append({"phone": phone, "name": name or phone})
    return {"contacts": contacts[:200]}

@api.post("/broadcast/upload-attachment")
async def upload_attachment(file: UploadFile = File(...)):
    meta = await save_uploaded_file(file)
    await db.files.insert_one(meta)
    return {"file_id": meta["_id"], "filename": meta["filename"]}

async def run_broadcast(job_id: str):
    job = await db.broadcasts.find_one({"_id": job_id})
    if not job:
        return
    # Only use ONLINE senders, or specific sender_id if provided
    forced_sender = job.get("sender_id")
    if forced_sender:
        senders = await db.senders.find({"_id": forced_sender}, {"_id": 0}).to_list(10)
    else:
        senders = await db.senders.find({"online": True}, {"_id": 0}).to_list(50)
    if not senders:
        # Fall back to any registered sender
        senders = await db.senders.find({}, {"_id": 0}).to_list(50)
    if not senders:
        await db.broadcasts.update_one({"_id": job_id}, {"$set": {"status": "failed", "error": "No senders available"}})
        return
    contacts = job["contacts"]
    mode = job["mode"]
    text = job.get("message", "") or ""
    attach_id = job.get("attachment_id")
    attach_name = job.get("attachment_name")
    total_msgs = len(contacts) * (len(senders) if mode == "B" else 1)
    await db.broadcasts.update_one({"_id": job_id}, {"$set": {"status": "running", "total": total_msgs, "sent": 0, "failed": 0}})

    def make_payloads():
        """Return the list of payloads to send.
        - Image/video + text -> ONE payload with caption (single WhatsApp message)
        - PDF/audio/doc + text -> TWO payloads (caption isn't shown inline for docs)
        - Only text or only attachment -> ONE payload
        """
        caption = text.strip()
        out = []
        if not attach_id:
            if caption:
                out.append({"type": "text", "text": caption})
            return out

        # Detect media kind from filename extension
        fname = (attach_name or "file").lower()
        ext = fname.rsplit(".", 1)[-1] if "." in fname else ""
        kind_map = {
            "jpg": ("image", "image/jpeg"),
            "jpeg": ("image", "image/jpeg"),
            "png": ("image", "image/png"),
            "webp": ("image", "image/webp"),
            "gif": ("image", "image/gif"),
            "mp4": ("video", "video/mp4"),
            "mov": ("video", "video/quicktime"),
            "3gp": ("video", "video/3gpp"),
            "mp3": ("audio", "audio/mpeg"),
            "ogg": ("audio", "audio/ogg"),
            "wav": ("audio", "audio/wav"),
            "m4a": ("audio", "audio/mp4"),
            "pdf": ("pdf", "application/pdf"),
        }
        media_type, mime = kind_map.get(ext, ("document", "application/octet-stream"))

        media_payload = {
            "type": media_type,
            "file_id": attach_id,
            "filename": attach_name or f"file.{ext or 'bin'}",
            "mimetype": mime,
        }
        # For image/video: attach caption directly so it's a single combined message.
        # For audio/pdf/document: send text separately because WA doesn't surface captions on docs.
        if caption and media_type in ("image", "video"):
            media_payload["caption"] = caption
            out.append(media_payload)
        else:
            if caption:
                out.append({"type": "text", "text": caption})
            out.append(media_payload)
        return out

    payloads = make_payloads()
    if not payloads:
        await db.broadcasts.update_one({"_id": job_id}, {"$set": {"status": "failed", "error": "Empty message"}})
        return

    for i, contact in enumerate(contacts):
        cur = await db.broadcasts.find_one({"_id": job_id})
        if cur and cur.get("status") == "paused":
            return
        ph = (contact.get("phone") or "").strip()
        if not ph:
            continue
        if mode == "B":
            assigned_senders = senders
        else:
            assigned_senders = [senders[i % len(senders)]]
        for s in assigned_senders:
            for p in payloads:
                doc = {
                    "_id": new_id(),
                    "phone": ph,
                    "payload": p,
                    "sender_id": s["id"],
                    "status": "pending",
                    "broadcast_id": job_id,
                    "created_at": now_iso(),
                }
                await db.outbox.insert_one(doc)
            # Tag this contact as blasted by this sender (first sender wins for Mode B)
            await db.blasted_contacts.update_one(
                {"_id": ph},
                {"$set": {"last_blasted_at": now_iso()},
                 "$setOnInsert": {"first_blasted_at": now_iso(), "sender_id": s["id"]}},
                upsert=True,
            )
        # Small async pause so we don't dump 50*N rows in 1ms (helps DB)
        await asyncio.sleep(0.05)
    # Mark queued; actual send count comes from worker acks
    await db.broadcasts.update_one({"_id": job_id}, {"$set": {"status": "queued_to_workers"}})

@api.post("/broadcast/start")
async def start_broadcast(payload: Dict[str, Any], background_tasks: BackgroundTasks):
    contacts = payload.get("contacts", [])
    if len(contacts) > 50:
        raise HTTPException(400, "Max 50 contacts per blast")
    # Normalize + validate phone numbers — drop malformed ones early so they don't burn sender reputation
    cleaned: List[Dict[str, Any]] = []
    invalid: List[str] = []
    for c in contacts:
        raw = (c.get("phone") or "").strip()
        norm = normalize_phone(raw)
        # Valid WhatsApp numbers: 12-digit Indian (91XXXXXXXXXX) or 12–15 digit international
        # Reject malformed inputs like "99870003415" (11 digits, no valid country code).
        is_valid = (
            (norm.startswith("91") and len(norm) == 12) or
            (12 <= len(norm) <= 15 and not norm.startswith("0"))
        )
        if is_valid:
            cleaned.append({**c, "phone": norm})
        else:
            invalid.append(raw or "(blank)")
    if not cleaned:
        raise HTTPException(400, f"All {len(contacts)} numbers are invalid. Examples: {', '.join(invalid[:3])}")
    job = BroadcastJob(
        id=new_id(),
        contacts=cleaned,
        message=payload.get("message", ""),
        attachment_id=payload.get("attachment_id"),
        attachment_name=payload.get("attachment_name"),
        mode=payload.get("mode", "A"),
        total=len(cleaned),
        created_at=now_iso(),
    ).model_dump()
    if invalid:
        job["invalid_numbers"] = invalid[:50]
    # Optional: force a single sender
    sender_id = payload.get("sender_id")
    if sender_id:
        job["sender_id"] = sender_id
    # Tag the group this blast came from (if any) so we can show per-group history
    group_id = payload.get("group_id")
    if group_id:
        job["group_id"] = group_id
        # Also store the group name snapshot at send time
        grp = await db.groups.find_one({"_id": group_id}, {"name": 1})
        if grp:
            job["group_name"] = grp.get("name")
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
    else:
        # Backfill webhook_secret on older settings docs
        s = await db.settings.find_one({"_id": "settings"}, {"_id": 0})
        if not s.get("webhook_secret"):
            await db.settings.update_one({"_id": "settings"}, {"$set": {"webhook_secret": uuid.uuid4().hex}})

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

    # Senders are now self-registered by Baileys workers when they scan QR. No seed needed.
    # Cleanup: remove any legacy seeded sender docs (empty phone + Disconnected status)
    await db.senders.delete_many({"phone": "", "status": "Disconnected"})


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
