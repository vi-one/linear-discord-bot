# ---------------------------------------------------------------------------
# linear-discord-bot
#
# Build:  docker build -t linear-discord-bot .
# Run:    docker run -d --name linear-discord-bot \
#           --env-file .env \
#           -v "$(pwd)/config.yml:/app/config.yml:ro" \
#           -v linear-discord-data:/app/data \
#           linear-discord-bot
# ---------------------------------------------------------------------------
FROM node:24-alpine

ENV NODE_ENV=production

WORKDIR /app

# Install production dependencies first for layer caching. `npm ci` needs a
# lockfile; fall back to `npm install` when building without one.
# --ignore-scripts blocks dependency lifecycle (postinstall) scripts from
# running at build time (supply-chain hardening); none of the runtime deps
# need them to function.
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev --ignore-scripts; else npm install --omit=dev --ignore-scripts; fi \
    && npm cache clean --force

# Application source
COPY src ./src

# Only the state directory is writable by the runtime user; application code
# and node_modules stay root-owned and read-only so a compromised process
# can't rewrite them for persistence.
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

# Expectations at runtime:
#   /app/config.yml  -> mount your config file here (read-only is fine)
#   /app/data        -> persist this volume so dedupe state survives restarts
VOLUME ["/app/data"]

CMD ["node", "src/index.js"]
