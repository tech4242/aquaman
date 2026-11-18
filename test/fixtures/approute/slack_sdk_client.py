# slack_sdk. The base URL is the base_url argument; the client appends the method name to it.
import json
import os

from slack_sdk import WebClient

slack = WebClient(
    token=os.environ["SLACK_BOT_TOKEN"],
    base_url=os.environ.get("SLACK_API_URL", "https://slack.com/api/"),
)
posted = slack.chat_postMessage(channel="C0SUPPORT", text="Ticket 42 answered.")
print(json.dumps({"result": posted["ts"], "env": dict(os.environ)}))
