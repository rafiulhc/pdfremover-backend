// AI resume builder: free preview + exact PDF, paid DOCX through Gumroad.
const express = require("express");
const { newTicket } = require("../services/tickets");
const { buyUrl, reconcilePayment } = require("../services/gumroad");
const {
  fetchResumeJsonText, normalizePreviewJson, previewHtml, resumeDocx,
} = require("../services/resume");

const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function noStore(res) {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  res.set("Surrogate-Control", "no-store");
}

function resumeRouter({ config, openai, http, browser, resumeTickets }) {
  const router = express.Router();
  const model = config.openaiModel;

  router.post("/api/ai/resume/prepare", express.json(), (req, res) => {
    const ticket = newTicket();
    resumeTickets.set(ticket, { paid: false, createdAt: Date.now(), inputs: req.body || {} });
    const url = buyUrl(config.gumroadResumePermalink, ticket, { ticketField: true });
    console.log("RESUME PREPARE", { ticket, buyUrl: url });
    res.json({ ticket, buyUrl: url });
  });

  router.get("/api/ai/resume/status", async (req, res) => {
    const ticket = String(req.query.ticket || "");
    const rec = resumeTickets.get(ticket);
    if (!rec) return res.status(404).json({ error: "Invalid ticket" });
    noStore(res);

    if (!rec.paid) {
      const paidNow = await reconcilePayment({
        http, ticket,
        accessToken: config.gumroadAccessToken,
        permalink: config.gumroadResumePermalink,
      });
      if (paidNow) { rec.paid = true; console.log("RESUME STATUS: payment reconciled from Gumroad API", { ticket }); }
    }
    res.json({ paid: rec.paid });
  });

  router.get("/api/ai/resume/download", async (req, res) => {
    try {
      const ticket = String(req.query.ticket || "");
      const rec = resumeTickets.get(ticket);
      if (!rec) return res.status(404).json({ error: "Invalid ticket" });
      if (!rec.paid) return res.status(402).json({ error: "Payment required" });
      if (!openai) return res.status(500).json({ error: "AI not configured" });

      const inputs = rec.inputs || {};
      const json = inputs.previewJson || JSON.parse(await fetchResumeJsonText(openai, model, inputs));
      const buf = await resumeDocx(inputs, json);

      res.setHeader("Content-Type", DOCX_TYPE);
      res.setHeader("Content-Disposition", 'attachment; filename="resume.docx"');
      res.send(buf);
    } catch (e) {
      console.error("resume download error:", e);
      res.status(500).json({ error: "Failed to generate resume" });
    }
  });

  router.post("/api/ai/resume/preview", express.json(), async (req, res) => {
    try {
      if (!openai) return res.status(500).json({ error: "AI not configured" });
      const inputs = req.body || {};
      const text = await fetchResumeJsonText(openai, model, inputs);

      let json = {};
      try { json = JSON.parse(text); } catch {}
      normalizePreviewJson(json, inputs);

      res.json({ json, html: previewHtml(inputs, json) });
    } catch (e) {
      console.error("resume preview error:", e);
      res.status(500).json({ error: "Failed to build preview" });
    }
  });

  // Free: exact-preview PDF (HTML -> PDF via headless Chrome).
  router.post("/api/ai/resume/pdf", express.json({ limit: "1mb" }), async (req, res) => {
    try {
      let { html, previewJson, ...inputs } = req.body || {};

      if (!html) {
        if (!previewJson) {
          if (!openai) return res.status(500).json({ error: "AI not configured" });
          previewJson = JSON.parse(await fetchResumeJsonText(openai, model, inputs));
        }
        html = previewHtml(inputs, normalizePreviewJson(previewJson, inputs));
      }

      const pdfBuf = await browser.htmlToPdf(html);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", 'attachment; filename="resume.pdf"');
      res.send(Buffer.from(pdfBuf));
    } catch (e) {
      console.error("resume exact pdf error:", e);
      res.status(500).json({ error: "Failed to render PDF" });
    }
  });

  return router;
}

module.exports = { resumeRouter, noStore };
