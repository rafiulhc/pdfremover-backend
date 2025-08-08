# Dockerfile
FROM node:18-bullseye

# Install LibreOffice + helpers + fonts
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
# Heroku provides $PORT; your app must listen on it (you already do)
CMD ["node", "index.js"]
