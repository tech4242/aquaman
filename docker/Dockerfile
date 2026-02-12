FROM alpine/openclaw:latest

# Install aquaman proxy (includes credential stores, audit, CLI)
RUN npm install -g aquaman-proxy@0.7.0

# Install plugin into OpenClaw extensions
RUN mkdir -p /home/node/.openclaw/extensions/aquaman-plugin
COPY plugin/package.json /home/node/.openclaw/extensions/aquaman-plugin/
COPY plugin/openclaw.plugin.json /home/node/.openclaw/extensions/aquaman-plugin/
COPY plugin/index.ts /home/node/.openclaw/extensions/aquaman-plugin/
COPY plugin/src/ /home/node/.openclaw/extensions/aquaman-plugin/src/

# Config
COPY openclaw-config.json /home/node/.openclaw/openclaw.json
COPY auth-profiles.json /home/node/.openclaw/agents/main/agent/auth-profiles.json

# Credential backend via env vars
ENV AQUAMAN_BACKEND=encrypted-file

# Plugin auto-spawns proxy with UDS — same code path as local
CMD ["node", "dist/index.js", "gateway", "--allow-unconfigured"]
