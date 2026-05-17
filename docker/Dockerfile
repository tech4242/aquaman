FROM alpine/openclaw:latest

# Install aquaman proxy (includes credential stores, audit, CLI)
RUN npm install -g aquaman-proxy@0.11.4

# Install plugin into OpenClaw extensions
# Note: docker build context must contain a prebuilt plugin/dist/ directory
# (run `npm run build -w aquaman-plugin && cp -r packages/plugin docker/plugin`
# before `docker build`). The manifest's `openclaw.extensions` field points at
# ./dist/index.js — the .ts source is not shipped.
RUN mkdir -p /home/node/.openclaw/extensions/aquaman-plugin
COPY plugin/package.json /home/node/.openclaw/extensions/aquaman-plugin/
COPY plugin/openclaw.plugin.json /home/node/.openclaw/extensions/aquaman-plugin/
COPY plugin/dist/ /home/node/.openclaw/extensions/aquaman-plugin/dist/

# Config
COPY openclaw-config.json /home/node/.openclaw/openclaw.json
COPY auth-profiles.json /home/node/.openclaw/agents/main/agent/auth-profiles.json

# Credential backend via env vars
ENV AQUAMAN_BACKEND=encrypted-file

# Plugin auto-spawns proxy with UDS — same code path as local
CMD ["node", "dist/index.js", "gateway", "--allow-unconfigured"]
