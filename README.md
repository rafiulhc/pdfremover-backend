# pdfremover-backend

API behind [pdfmergersplitter.app](https://www.pdfmergersplitter.app): merge, split, compress and convert PDFs, plus a paid AI resume builder and PDF→Word conversion (CloudConvert + Gumroad).

## Layout

```
index.js            entry point (Procfile, heroku.yml and Dockerfile run it)
src/server.js       listen, LibreOffice prewarm, graceful shutdown on SIGTERM
src/app.js          builds the Express app; real clients in createDeps(), fakes in tests
src/config.js       every environment variable, read once
src/routes/         health, pdf, convert (LibreOffice), image, resume, pro, gumroad
src/services/       tickets, gumroad, resume rendering + prompt
src/lib/            concurrency limit, temp files, converters, headless Chromium
test/               node:test + supertest, no network or API keys needed
scripts/smoke.js    end-to-end check of a running server, including the heavy routes
```

## Run

Needs Node 24 (`nvm use`). Converting Office files also needs LibreOffice, Ghostscript and Poppler, so the easy way is Docker:

```bash
docker build -t pdfremover-backend .
docker run --rm -p 4000:4000 --env-file .env pdfremover-backend
node scripts/smoke.js http://localhost:4000
```

Without Docker: `cp .env.example .env`, `npm ci`, `npm run dev`.

## Check

```bash
npm test
npm run lint
npm audit --omit=dev
```

## Known limits (fixed in later stages)

- Payment tickets are kept in memory, so only one instance can run. A second replica behind a load balancer would answer "Invalid ticket" for tickets created on the first.
- Heavy conversions run inside the web process, limited by `HEAVY_CONCURRENCY`.
- The image is about 2.3 GB (LibreOffice + Chromium).
