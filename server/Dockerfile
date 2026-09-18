# pear-server: Pear as a web app (desktop + touch UI) behind one port.
# Build from the repository root:
#   docker build -f server/Dockerfile -t pear-server .

FROM node:22-bookworm AS build
WORKDIR /src
# The desktop shell is not part of this image; don't fetch ~100 MB of Electron.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package.json package-lock.json ./
COPY core/package.json core/
COPY desktop/package.json desktop/
COPY ui/package.json ui/
COPY mobile/package.json mobile/
COPY server/package.json server/
RUN npm ci --no-audit --no-fund
COPY core core
COPY ui ui
COPY mobile mobile
COPY server server
RUN npm run build -w core \
 && npm run build -w ui \
 && npm run build -w mobile \
 && npm run build -w server
# Runtime needs core's and server's production deps only (ssh2, node-pty, ws,
# the MCP SDK) — not Angular, not Electron.
RUN npm prune --omit=dev -w core -w server \
 && rm -rf node_modules/electron node_modules/@angular node_modules/monaco-editor \
           node_modules/typescript node_modules/esbuild node_modules/@esbuild

FROM node:22-bookworm-slim
# tar: multi-file downloads. openssh-client: not used by Pear (ssh2 is pure JS)
# but handy in the local-host shell; tini reaps the PTYs' children.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini tar ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /src/package.json ./
COPY --from=build /src/node_modules node_modules
COPY --from=build /src/core/package.json core/
COPY --from=build /src/core/node core/node
COPY --from=build /src/core/dist core/dist
COPY --from=build /src/server/package.json server/
COPY --from=build /src/server/dist server/dist
COPY --from=build /src/server/public server/public
COPY --from=build /src/ui/dist/ui/browser ui/dist/ui/browser
COPY --from=build /src/mobile/dist/mobile/browser mobile/dist/mobile/browser

# Hosts, encrypted secrets, known_hosts, login sessions and the config file
# (with the password hash) all live here — mount it.
ENV PEAR_DATA_DIR=/data \
    XDG_CONFIG_HOME=/data/config \
    PEAR_HOST=0.0.0.0 \
    NODE_ENV=production
# A named volume inherits the image directory's ownership — create it as the
# unprivileged user, or the first write (secret.key) fails with EACCES.
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 7327
USER node
ENTRYPOINT ["tini", "--", "node", "server/dist/cli.js"]
