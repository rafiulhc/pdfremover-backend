# ---- base runtime ----
FROM node:20-bookworm-slim

# Set working dir and non-root user
WORKDIR /app
RUN useradd -m app && chown -R app:app /app

# OS deps:
# - LibreOffice/GS/Poppler for your other tools
# - chromium for puppeteer-core (system browser)
# - fonts for nicer resume rendering
# - tini as PID 1 (we'll use -s to enable subreaper)
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      libreoffice \
      libreoffice-writer \
      ghostscript \
      poppler-utils \
      chromium \
      fonts-dejavu-core \
      fonts-liberation \
      ca-certificates \
      curl \
      tini \
    && rm -rf /var/lib/apt/lists/*

# Ensure fast temp disk path exists and is writable
ENV TMPDIR=/tmp
RUN mkdir -p /tmp && chown -R app:app /tmp

# Make sure Chromium is discoverable by puppeteer-core
# (your code also resolves common paths, but this makes it explicit)
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Set HOME so LibreOffice has a place for its profile
ENV HOME=/home/app

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

# Drop root
USER app

# Use tini as PID 1; add -s to act as subreaper (fixes your warning) and -g to forward to process group
ENTRYPOINT ["/usr/bin/tini", "-s", "-g", "--"]

# Start the server (no shell so signals propagate cleanly)
CMD ["node", "index.js"]
