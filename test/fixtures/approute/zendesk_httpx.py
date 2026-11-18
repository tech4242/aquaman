# Zendesk with httpx and HTTP basic auth: "{email}/token" as the user name, the API token as the password.
import json
import os

import httpx

base = os.environ.get("ZENDESK_API_URL", "https://example.zendesk.com")
res = httpx.get(
    f"{base}/api/v2/tickets.json",
    auth=(f"{os.environ['ZENDESK_EMAIL']}/token", os.environ["ZENDESK_API_TOKEN"]),
    timeout=30,
)
print(json.dumps({"status": res.status_code, "result": [t["id"] for t in res.json().get("tickets", [])], "env": dict(os.environ)}))
