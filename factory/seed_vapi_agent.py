import os
import json
import httpx
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

PROJECT_ROOT = Path(__file__).resolve().parent.parent
VAPI_API_URL = "https://api.vapi.ai"

def get_vapi_headers(api_key: str):
    return {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json"
    }

def seed_inbound_assistant(api_key: str, backend_domain: str = "https://api.oceancountyroofingpros.com"):
    """
    Creates or updates the Inbound Voice Assistant ('Sarah') in Vapi via REST API.
    Configures Deepgram transcription, Cartesia TTS voice, system prompt, and server tools.
    """
    prompt_file = PROJECT_ROOT / "vapi" / "inbound_system_prompt.md"
    with open(prompt_file, "r", encoding="utf-8") as f:
        system_prompt = f.read()

    # Define Server Tools
    tools = [
        {
            "type": "function",
            "function": {
                "name": "check_availability",
                "description": "Checks available inspection appointment windows for a given date in Ocean County.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "date": {
                            "type": "string",
                            "description": "Date in YYYY-MM-DD format (e.g. 2026-11-12)."
                        }
                    },
                    "required": ["date"]
                }
            },
            "server": {
                "url": f"{backend_domain}/api/vapi/tools"
            }
        },
        {
            "type": "function",
            "function": {
                "name": "book_inspection",
                "description": "Books a free 21-point roof inspection with the local Ocean County estimator.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string", "description": "Full name of the homeowner."},
                        "phone": {"type": "string", "description": "Customer mobile phone number."},
                        "address": {"type": "string", "description": "Street address and town."},
                        "service": {"type": "string", "description": "Roofing service requested."},
                        "date": {"type": "string", "description": "Inspection date in YYYY-MM-DD format."},
                        "time": {"type": "string", "description": "Time window (e.g. 10:00 AM, 1:00 PM)."}
                    },
                    "required": ["name", "phone", "address", "date", "time"]
                }
            },
            "server": {
                "url": f"{backend_domain}/api/vapi/tools"
            }
        }
    ]

    assistant_payload = {
        "name": "Sarah - Ocean County Roofing Pros (Inbound)",
        "model": {
            "provider": "openai",
            "model": "gpt-4o-mini",
            "messages": [
                {
                    "role": "system",
                    "content": system_prompt
                }
            ],
            "tools": tools
        },
        "voice": {
            "provider": "cartesia",
            "voiceId": "248be419-c632-4f23-adf1-5324ed7dbf10"  # Helpful, friendly female voice
        },
        "transcriber": {
            "provider": "deepgram",
            "model": "nova-2",
            "language": "en-US"
        },
        "firstMessage": "Thanks for calling Ocean County Roofing Pros! This is Sarah. Are you looking to schedule a free roof inspection or dealing with an active leak today?",
        "serverUrl": f"{backend_domain}/api/vapi/end-of-call"
    }

    print("Connecting to Vapi REST API...")
    with httpx.Client(timeout=15.0) as client:
        response = client.post(
            f"{VAPI_API_URL}/assistant",
            json=assistant_payload,
            headers=get_vapi_headers(api_key)
        )

        if response.status_code in [200, 201]:
            data = response.json()
            assistant_id = data.get("id")
            print(f"[SUCCESS] Vapi Inbound Assistant Created! Assistant ID: {assistant_id}")
            return assistant_id
        else:
            print(f"[ERROR] Failed to create assistant ({response.status_code}): {response.text}")
            return None

if __name__ == "__main__":
    vapi_key = os.getenv("VAPI_API_KEY")
    if not vapi_key or vapi_key == "YOUR_VAPI_PRIVATE_API_KEY":
        print("Please set your VAPI_API_KEY in .env before running this script.")
    else:
        seed_inbound_assistant(vapi_key)
