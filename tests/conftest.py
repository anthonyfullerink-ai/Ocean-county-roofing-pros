import os
import tempfile
import pytest
from app.config import settings


def pytest_configure(config):
    """Isolate pytest from live Supabase, live SMS carriers, and the committed mirror SQLite DB."""
    settings.MOCK_MODE = True
    settings.SUPABASE_URL = ""
    settings.SUPABASE_KEY = ""
    os.environ["SUPABASE_URL"] = ""
    os.environ["SUPABASE_KEY"] = ""
    os.environ["OCRP_SEED_DEMO_DATA"] = "1"
    tmp_db = os.path.join(tempfile.gettempdir(), f"ocrp_pytest_mirror_{os.getpid()}.db")
    if os.path.exists(tmp_db):
        try:
            os.remove(tmp_db)
        except OSError:
            pass
    settings.LOCAL_DB_PATH = tmp_db
    os.environ["LOCAL_DB_PATH"] = tmp_db
    from app.services.db import init_db
    init_db()
