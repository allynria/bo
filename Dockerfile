## stage: deps
FROM node:22-alpine AS deps

ENV NODE_ENV=production
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

## stage: runner
FROM node:22-alpine AS runner

# Set production env and enforce minimal base image
ENV NODE_ENV=production \
    LOG_JSON=1 \
    PORT=3000 \
    TMPDIR=/tmp \
    NODE_OPTIONS="--enable-source-maps"

# Create non-root user and group
RUN addgroup -g 10001 app && adduser -D -u 10001 -G app app

WORKDIR /home/app

# Copy production node_modules from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy source (node_modules excluded via .dockerignore)
COPY . .

# Prepare writable mounts: tmp and app work dir (others stay read-only at runtime via orchestrator settings)
RUN mkdir -p /tmp /home/app/data && chown -R app:app /tmp /home/app

# Switch to non-root user
USER app

# Default command; respect PORT and other envs
CMD ["node", "scripts/service.js"]

# Container-level healthcheck to surface probe failures (liveness)
HEALTHCHECK --interval=20s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" >/dev/null || exit 1
