import sys
from pathlib import Path

# Ensure repository root is on Python sys.path in Netlify's container
ROOT_DIR = Path(__file__).resolve().parent.parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from mangum import Mangum
from app.main import app

# AWS Lambda / Netlify Serverless Function Handler
handler = Mangum(app, lifespan="off")
