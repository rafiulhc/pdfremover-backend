# Dockerfile
FROM node:18-bullseye

# Install LibreOffice + PDF utils + common fonts (good fidelity)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libreoffice libreoffice-writer libreoffice-core libreoffice-common \
    ghostscript poppler-utils \
    fonts-dejavu fonts-liberation \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

ENV NODE_ENV=production
# Heroku provides $PORT; your server already uses process.env.PORT
CMD ["node", "index.js"]
