FROM node:22-alpine

# Set production env and enforce minimal base image
ENV NODE_ENV=production \
    LOG_JSON=1 \
    PORT=3000 \
    TMPDIR=/tmp

# Create non-root user and group
RUN addgroup -g 10001 app && adduser -D -u 10001 -G app app

WORKDIR /home/app

# Install dependencies (omit dev for production image)
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy source
COPY . .

# Prepare writable mounts: tmp and app work dir (others stay read-only at runtime via orchestrator settings)
RUN mkdir -p /tmp /home/app/data && chown -R app:app /tmp /home/app

# Switch to non-root user
USER app

# Default command; respect PORT and other envs
CMD ["node", "scripts/service.js"]

