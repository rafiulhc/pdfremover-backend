// Builds the Express app. No listen(), no timers: server.js runs it, tests import it.
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const os = require("os");
const path = require("path");
const axios = require("axios");
const CloudConvert = require("cloudconvert");
const { OpenAI } = require("openai");

const { createHeavyWrapper } = require("./lib/limit");
const { createBrowser } = require("./lib/browser");
const { createTicketStore } = require("./services/tickets");
const { healthRouter } = require("./routes/health");
const { pdfRouter } = require("./routes/pdf");
const { convertRouter } = require("./routes/convert");
const { imageRouter } = require("./routes/image");
const { resumeRouter } = require("./routes/resume");
const { proRouter } = require("./routes/pro");
const { gumroadRouter } = require("./routes/gumroad");

// Real clients and stores. Tests pass their own fakes to createApp instead.
function createDeps(config, overrides = {}) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdfapp-"));
  return {
    config,
    outDir,
    upload: multer({ dest: outDir, limits: { fileSize: config.uploadMaxBytes, files: config.uploadMaxFiles } }),
    heavy: createHeavyWrapper(config.heavyConcurrency),
    openai: config.openaiApiKey ? new OpenAI({ apiKey: config.openaiApiKey }) : null,
    cloudConvert: new CloudConvert(config.cloudConvertApiKey),
    http: axios,
    browser: createBrowser({ chromiumPath: config.chromiumPath }),
    tickets: createTicketStore({ ttlMs: config.ticketTtlMs }),
    resumeTickets: createTicketStore({ ttlMs: config.ticketTtlMs }),
    ...overrides,
  };
}

function createApp(deps) {
  const app = express();
  app.disable("x-powered-by");

  app.use(cors({
    origin: deps.config.corsOrigins,
    methods: ["POST", "GET", "OPTIONS"],
    allowedHeaders: ["Content-Type"]
  }));
  app.use(express.urlencoded({ extended: true }));

  app.use(healthRouter());
  app.use(pdfRouter(deps));
  app.use(convertRouter(deps));
  app.use(imageRouter(deps));
  app.use(resumeRouter(deps));
  app.use(proRouter(deps));
  app.use(gumroadRouter(deps));

  // Upload limits and other multer errors: reply 400/413 instead of an HTML stack trace.
  app.use((err, _req, res, _next) => {
    if (err instanceof multer.MulterError) {
      const status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
      return res.status(status).json({ error: err.message });
    }
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: "Internal error" });
  });

  return app;
}

module.exports = { createApp, createDeps };
