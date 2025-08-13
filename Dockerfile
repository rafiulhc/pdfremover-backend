# ---- base runtime ----
FROM node:20-bookworm-slim

# Set working dir and non-root user
WORKDIR /app
RUN useradd -m app && chown -R app:app /app

# OS deps: LibreOffice (headless), Ghostscript, Poppler, fonts, tini
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      libreoffice \
      libreoffice-writer \
      ghostscript \
      poppler-utils \
      fonts-dejavu-core \
      ca-certificates \
      curl \
      tini \
    && rm -rf /var/lib/apt/lists/*

# Ensure fast temp disk path exists and is writable
ENV TMPDIR=/tmp
RUN mkdir -p /tmp && chown -R app:app /tmp

# Copy only package files first (cache layer)
COPY package*.json ./

# Install prod deps only
RUN npm ci --omit=dev

# Copy app (adjust if you have a build step)
COPY . .

# App ports & environment
ENV NODE_ENV=production
ENV PORT=4000
# Useful defaults for stability on small dynos
ENV WEB_CONCURRENCY=2
ENV NODE_OPTIONS="--max-old-space-size=512"
# Set HOME so LibreOffice has a place for its profile
ENV HOME=/home/app

# Drop root
USER app

# Use tini as PID 1 to reap child processes and forward signals to group (-g)
ENTRYPOINT ["/usr/bin/tini", "-g", "--"]

# (Optional but nice) Healthcheck hitting your /health route if you added it
# HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
#   CMD wget -qO- "http://127.0.0.1:${PORT}/health" || exit 1

# Start the server (no shell so signals propagate cleanly)
CMD ["node", "index.js"]
