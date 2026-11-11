import logging
import os
from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.responses import HTMLResponse
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.routes import leads, vapi, web

# Configure Logging
logging.basicConfig(
    level=logging.INFO if not settings.DEBUG else logging.DEBUG,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
)
logger = logging.getLogger("ocean_county_roofing")

app = FastAPI(
    title=settings.BUSINESS_NAME,
    description="High-Converting Lead Engine & Voice AI Dispatcher for Ocean County, NJ",
    version="1.0.0"
)

# Enable CORS for web form submission
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Setup Templates & Static Files
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")

os.makedirs(STATIC_DIR, exist_ok=True)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

# Include API Routers First
app.include_router(leads.router)
app.include_router(vapi.router)

# Include Dynamic Web & Geo-Silo Router
app.include_router(web.router)

@app.get("/health")
async def health_check():
    return {
        "status": "online",
        "business": settings.BUSINESS_NAME,
        "mock_mode": settings.MOCK_MODE,
        "outbound_callback_enabled": settings.ENABLE_OUTBOUND_CALLBACK
    }
