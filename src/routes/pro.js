// Paid PDF -> DOCX through CloudConvert. Flow: prepare (upload + start job) ->
// user pays on Gumroad -> status polls until paid and ready -> download proxies the file.
const express = require("express");
const fs = require("fs");
const { safeUnlink } = require("../lib/files");
const { newTicket } = require("../services/tickets");
const { buyUrl, reconcilePayment } = require("../services/gumroad");
const { noStore } = require("./resume");

const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function proRouter({ config, cloudConvert, http, tickets, upload }) {
  const router = express.Router();

  router.post("/api/pro/prepare", upload.single("file"), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    if (!config.cloudConvertApiKey) {
      safeUnlink(req.file.path);
      return res.status(500).json({ error: "CloudConvert not configured" });
    }

    const ticket = newTicket();
    const origName = req.file.originalname || "input.pdf";

    try {
      const job = await cloudConvert.jobs.create({
        tasks: {
          "import-1": { operation: "import/upload" },
          "convert-1": { operation: "convert", input: "import-1", input_format: "pdf", output_format: "docx" },
          "export-1": { operation: "export/url", input: "convert-1" }
        }
      });

      const uploadTask = job.tasks.find(t => t.name === "import-1");
      await cloudConvert.tasks.upload(uploadTask, fs.createReadStream(req.file.path), origName);

      tickets.set(ticket, { jobId: job.id, paid: false, ready: false, file: null, createdAt: Date.now(), error: null });

      // Wait for the conversion in the background; status also refreshes it.
      cloudConvert.jobs.wait(job.id)
        .then((finished) => {
          const file = cloudConvert.jobs.getExportUrls(finished)?.[0];
          const rec = tickets.get(ticket);
          if (rec) {
            rec.ready = !!file;
            rec.file = file || null;
            if (!file) rec.error = "No export URL from CloudConvert";
          }
        })
        .catch((e) => {
          const rec = tickets.get(ticket);
          if (rec) rec.error = e.message || "CloudConvert failed";
        });

      const url = buyUrl(config.gumroadProductPermalink, ticket);
      console.log("PRO PREPARE RESP:", { ticket, buyUrl: url });
      res.json({ ticket, buyUrl: url });
    } catch (e) {
      console.error("pro/prepare error:", e);
      res.status(500).json({ error: "Failed to initialize conversion" });
    } finally {
      safeUnlink(req.file.path);
    }
  });

  router.get("/api/pro/status", async (req, res) => {
    const ticket = String(req.query.ticket || "");
    const rec = tickets.get(ticket);
    if (!rec) return res.status(404).json({ error: "Invalid ticket" });
    noStore(res);

    try {
      if (!rec.ready && rec.jobId) {
        const job = await cloudConvert.jobs.get(rec.jobId);
        const file = cloudConvert.jobs.getExportUrls(job)?.[0];
        if (file) {
          rec.ready = true;
          rec.file = file;
          console.log("STATUS: CC ready via refresh", { ticket, filename: file.filename });
        }
      }
    } catch {}

    if (!rec.paid) {
      const paidNow = await reconcilePayment({
        http, ticket,
        accessToken: config.gumroadAccessToken,
        permalink: config.gumroadProductPermalink,
      });
      if (paidNow) { rec.paid = true; console.log("STATUS: payment reconciled from Gumroad API", { ticket }); }
    }

    res.json({ paid: rec.paid, ready: rec.ready, error: rec.error || null });
  });

  // Download if paid and ready (proxy stream from the CloudConvert URL).
  router.get("/api/pro/download", async (req, res) => {
    const ticket = String(req.query.ticket || "");
    const rec = tickets.get(ticket);
    if (!rec) return res.status(404).json({ error: "Invalid ticket" });
    if (rec.error) return res.status(500).json({ error: rec.error });
    if (!rec.paid) return res.status(402).json({ error: "Payment required" });
    if (!rec.ready || !rec.file?.url) return res.status(425).json({ error: "Conversion not ready yet" });

    try {
      const stream = await http.get(rec.file.url, { responseType: "stream" });
      const filename = (rec.file.filename || "converted.docx").replace(/[/\\"]/g, "_");
      res.setHeader("Content-Type", DOCX_TYPE);
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      stream.data.pipe(res);
    } catch (e) {
      console.error("download error:", e);
      res.status(500).json({ error: "Failed to fetch file" });
    }
  });

  return router;
}

module.exports = { proRouter };
