# aquaman as an Agent Substrate credential provider: the daemon and the gRPC
# packages its provider listener needs, nothing else.
#
#   docker build -t aquaman-credential-provider:<version> deploy/substrate
#
# Every package in the image is pinned by package-lock.json next to this file,
# and the base image by digest; Dependabot keeps both current.
#
# To build from a checkout instead of the published aquaman-proxy, make a
# directory the build context, copy package.json and package-lock.json from
# here into it, add the output of `npm pack` (run in packages/proxy after
# `npm run build`), and name the tarball:
#
#   docker build -f deploy/substrate/Dockerfile \
#     --build-arg AQUAMAN_TARBALL=aquaman-proxy-<version>.tgz -t <image> /that/dir
FROM node:24-slim@sha256:873f586f3794f52281bd039bf02c048a0be08fde619338f9941bad1eb6b34530
WORKDIR /opt/aquaman
COPY package.json package-lock.json ./
ARG AQUAMAN_TARBALL=
# --omit=optional leaves out the desktop keychain binding, which has no use in
# a pod. No package here needs its install script at runtime. The bind mount
# (BuildKit, the default of `docker build`) is how a local tarball is seen.
RUN --mount=type=bind,target=/ctx \
    npm ci --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund \
 && if [ -n "$AQUAMAN_TARBALL" ]; then \
      npm install --omit=optional --ignore-scripts --no-save --no-package-lock --no-audit --no-fund "/ctx/$AQUAMAN_TARBALL"; \
    fi \
 && npm cache clean --force \
 # The manifest mounts a volume at /aqm. Without one (docker run) the directory
 # still has to exist and be writable by the user the daemon runs as.
 && mkdir -p /aqm && chown 65532:65532 /aqm
ENV PATH=/opt/aquaman/node_modules/.bin:$PATH HOME=/aqm AQUAMAN_CONFIG_DIR=/aqm NO_COLOR=1
USER 65532:65532
# config.yaml comes from a ConfigMap mounted as a directory, so that an edit
# reaches the running daemon; the config directory itself has to be writable
# (audit log, socket, pid file), so the file is linked into it.
ENTRYPOINT ["/bin/sh", "-c", "ln -sf /etc/aquaman/config.yaml /aqm/config.yaml && exec aquaman daemon"]
