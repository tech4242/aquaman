# Anthropic SDK for Python. Reads ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL from the environment.
import json
import os

import anthropic

client = anthropic.Anthropic()
message = client.messages.create(
    model="claude-opus-5-5",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Summarize ticket 42 in one sentence."}],
)
print(json.dumps({"result": message.content[0].text, "env": dict(os.environ)}))
