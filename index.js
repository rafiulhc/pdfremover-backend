// index.js
const express = require("express");
const multer = require("multer");
const cors = require("cors");
const { PDFDocument } = require("pdf-lib");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const sharp = require("sharp");
const archiver = require("archiver");
const { mkdtempSync, rmSync } = require("fs");
const os = require("os");
const { randomUUID } = require("crypto");
const axios = require("axios");

// --- CloudConvert (hi-fidelity PDF->DOCX) ---
const CloudConvert = require("cloudconvert");
const cloudConvert = new CloudConvert(process.env.CLOUDCONVERT_API_KEY);

// ---------- app + basics ----------
const app = express();
app.disable("x-powered-by");

// CORS: include all your frontends
app.use(cors({
  origin: [
    "http://localhost:3000",
    "https://pdfremover-frontend.vercel.app",
    "https://pdfmergersplitter.app",
    "https://www.pdfmergersplitter.app"
  ],
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"]
}));

// For Gumroad webhook (form POST)
app.use("/api/gumroad/ping", express.urlencoded({ extended: true }));

const OUTDIR = path.join(process.cwd(), "uploads");
fs.mkdirSync(OUTDIR, { recursive: true });

const upload = multer({ dest: OUTDIR });

// In-memory ticket store (move to Redis if you scale to multiple dynos)
const tickets = new Map(); // ticket -> { paid, ready, jobId, file, createdAt }

// ---------- helpers ----------
function resolveSofficeBin() {
  if (process.env.SOFFICE_BIN) return process.env.SOFFICE_BIN;
  const candidates = [
    "/usr/bin/libreoffice",
    "/usr/bin/soffice",
    "/usr/lib/libreoffice/program/soffice",
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return "soffice";
}
const SOFFICE_CMD = resolveSofficeBin();
console.log("Resolved soffice path:", SOFFICE_CMD);

function runSoffice(args, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(SOFFICE_CMD, args, {
      env: { ...process.env, HOME: process.env.HOME || "/tmp" },
    });
    let stderr = "", stdout = "";
    const to = setTimeout(() => { try { child.kill("SIGKILL"); } catch {}; reject(new Error(`LibreOffice timeout after ${timeoutMs}ms`)); }, timeoutMs);
    child.stdout.on("data", d => (stdout += d.toString()));
    child.stderr.on("data", d => (stderr += d.toString()));
    child.on("error", err => { clearTimeout(to); reject(new Error(`Failed to start soffice (${SOFFICE_CMD}): ${err.message}`)); });
    child.on("close", code => { clearTimeout(to); if (code === 0) return resolve({ stdout, stderr }); reject(new Error(`soffice exited with code ${code}\n${stderr || stdout}`)); });
  });
}

function findConverted(outDir, baseNoExt, targetExt) {
  const files = fs.readdirSync(outDir).filter(f =>
    f.toLowerCase().endsWith(`.${targetExt}`) &&
    (f.startsWith(baseNoExt) || f.includes(baseNoExt))
  );
  if (!files.length) return null;
  let newest = files[0], newestTime = fs.statSync(path.join(outDir, newest)).mtimeMs;
  for (const f of files) {
    const t = fs.statSync(path.join(outDir, f)).mtimeMs;
    if (t > newestTime) { newest = f; newestTime = t; }
  }
  return path.join(outDir, newest);
}

function runGhostscript(inputPath, outputPath, opts = {}) {
  return new Promise((resolve, reject) => {
    const {
      pdfsettings = "/ebook",
      colorRes = 120,
      grayRes = 120,
      monoRes = 120
    } = opts;
    const args = [
      "-sDEVICE=pdfwrite",
      "-dCompatibilityLevel=1.4",
      `-dPDFSETTINGS=${pdfsettings}`,
      "-dNOPAUSE", "-dQUIET", "-dBATCH",
      "-dDetectDuplicateImages=true",
      "-dCompressFonts=true",
      "-dSubsetFonts=true",
      "-dDownsampleColorImages=true",
      `-dColorImageResolution=${colorRes}`,
      "-dDownsampleGrayImages=true",
      `-dGrayImageResolution=${grayRes}`,
      "-dDownsampleMonoImages=true",
      `-dMonoImageResolution=${monoRes}`,
      `-sOutputFile=${outputPath}`,
      inputPath
    ];
    const child = spawn("gs", args);
    let stderr = "";
    child.stderr.on("data", d => (stderr += d.toString()));
    child.on("error", err => reject(err));
    child.on("close", code => { if (code === 0) return resolve(); reject(new Error(`Ghostscript exited ${code}: ${stderr}`)); });
  });
}

// ---------- EXISTING ROUTES (unchanged) ----------

// Remove pages
app.post("/api/remove-pages", upload.single("file"), async (req, res) => {
  try {
    const filePath = req.file.path;
    const buffer = fs.readFileSync(filePath);

    const pagesToRemove = (req.body.pagesToRemove || "")
      .split(",").map(s => s.trim()).filter(Boolean)
      .map(n => parseInt(n, 10) - 1);

    const srcPdf = await PDFDocument.load(buffer);
    const total = srcPdf.getPageCount();

    const keepIndices = [];
    for (let i = 0; i < total; i++) {
      if (!pagesToRemove.includes(i)) keepIndices.push(i);
    }

    const outPdf = await PDFDocument.create();
    const copied = await outPdf.copyPages(srcPdf, keepIndices);
    copied.forEach(p => outPdf.addPage(p));
    const outBytes = await outPdf.save();

    try { fs.unlinkSync(filePath); } catch {}

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="cleaned.pdf"');
    res.send(Buffer.from(outBytes));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Processing failed" });
  }
});

// Merge PDFs
app.post("/api/merge-pdfs", upload.array("files"), async (req, res) => {
  try {
    if (!req.files || req.files.length < 2) {
      return res.status(400).json({ error: "Please upload at least two PDF files." });
    }
    const mergedPdf = await PDFDocument.create();
    for (const file of req.files) {
      const buffer = fs.readFileSync(file.path);
      const pdf = await PDFDocument.load(buffer);
      const copiedPages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
      copiedPages.forEach((page) => mergedPdf.addPage(page));
      try { fs.unlinkSync(file.path); } catch {}
    }
    const mergedBytes = await mergedPdf.save();
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="merged.pdf"');
    res.send(Buffer.from(mergedBytes));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to merge PDFs" });
  }
});

// DOCX -> PDF (LibreOffice)
app.post("/api/convert/docx-to-pdf", upload.single("file"), async (req, res) => {
  const tmpPath = req.file?.path;
  if (!tmpPath) return res.status(400).json({ error: "No file uploaded" });
  const origName = req.file.originalname || "input.docx";
  const baseNoExt = path.parse(origName).name;
  const outDir = OUTDIR;

  try {
    await runSoffice([
      "--headless","--nologo",
      "-env:UserInstallation=file:///tmp/lo_profile",
      "--convert-to","pdf",
      "--outdir", outDir,
      tmpPath
    ]);
    const outFile =
      findConverted(outDir, baseNoExt, "pdf") ||
      findConverted(outDir, path.parse(tmpPath).name, "pdf");
    if (!outFile || !fs.existsSync(outFile)) throw new Error("Conversion output not found");

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="converted.pdf"');
    res.send(fs.readFileSync(outFile));
  } catch (e) {
    console.error("docx->pdf error:", e.message);
    res.status(500).json({
      error: e.message.includes("soffice")
        ? "Converter not available on server"
        : `Conversion failed: ${e.message}`
    });
  } finally {
    try { fs.unlinkSync(tmpPath); } catch {}
    try {
      const cleanup =
        findConverted(outDir, baseNoExt, "pdf") ||
        findConverted(outDir, path.parse(tmpPath).name, "pdf");
      if (cleanup) fs.unlinkSync(cleanup);
    } catch {}
  }
});

// PDF -> DOCX (LibreOffice baseline; free path)
app.post("/api/convert/pdf-to-docx", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  const tmpPath = req.file.path;
  const origName = req.file.originalname || "input.pdf";
  const baseNoExt = path.parse(origName).name;
  const outDir = OUTDIR;

  try {
    await runSoffice([
      "--headless","--nologo",
      "-env:UserInstallation=file:///tmp/lo_profile",
      "--convert-to","docx",
      "--outdir", outDir,
      tmpPath
    ]);
    const outFile =
      findConverted(outDir, baseNoExt, "docx") ||
      findConverted(outDir, path.parse(tmpPath).name, "docx");
    if (!outFile || !fs.existsSync(outFile)) throw new Error("Conversion output not found");
    const bytes = fs.readFileSync(outFile);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", 'attachment; filename="converted.docx"');
    res.send(bytes);
  } catch (e) {
    console.error("pdf->docx error:", e.message);
    res.status(500).json({ error: "Conversion failed: " + e.message });
  } finally {
    try { fs.unlinkSync(tmpPath); } catch {}
    try {
      const cleanup =
        findConverted(outDir, baseNoExt, "docx") ||
        findConverted(outDir, path.parse(tmpPath).name, "docx");
      if (cleanup) fs.unlinkSync(cleanup);
    } catch {}
  }
});

// Compress image
app.post("/api/compress/image", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  const targetKb = Math.max(50, parseInt(req.body.targetKb || "500", 10));
  let format = String((req.body.format || "webp")).toLowerCase();
  if (format === "jpg") format = "jpeg";
  if (!["webp", "jpeg", "png"].includes(format)) format = "webp";

  const inPath = req.file.path;
  try {
    const input = fs.readFileSync(inPath);
    const meta = await sharp(input).metadata();
    let width = meta.width || 2000;

    let quality = 82;
    let attempt = 0;
    let outBuf = null;

    while (attempt < 10) {
      const candidateWidth = attempt < 4 ? width : Math.max(600, Math.floor(width * Math.pow(0.85, attempt - 3)));
      let pipeline = sharp(input).resize(candidateWidth, null, { fit: "inside", withoutEnlargement: true });

      if (format === "webp") pipeline = pipeline.webp({ quality, effort: 4 });
      else if (format === "jpeg") pipeline = pipeline.flatten({ background: "#ffffff" }).jpeg({ quality, mozjpeg: true });
      else pipeline = pipeline.png({ compressionLevel: 9, palette: true });

      outBuf = await pipeline.toBuffer();
      if (outBuf.length <= targetKb * 1024) break;
      if (format === "webp" || format === "jpeg") quality = Math.max(45, quality - 8);
      attempt++;
    }
    const ct = format === "webp" ? "image/webp" : (format === "jpeg" ? "image/jpeg" : "image/png");
    const ext = format === "webp" ? "webp" : (format === "jpeg" ? "jpg" : "png");
    res.setHeader("Content-Type", ct);
    res.setHeader("Content-Disposition", `attachment; filename="compressed.${ext}"`);
    res.send(outBuf);
  } catch (e) {
    console.error("image compress error:", e);
    res.status(500).json({ error: "Failed to compress image" });
  } finally {
    try { fs.unlinkSync(inPath); } catch {}
  }
});

// Compress PDF
app.post("/api/compress/pdf", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  const targetKb = Math.max(100, parseInt(req.body.targetKb || "500", 10));
  const inPath = req.file.path;
  const base = path.parse(inPath).name;
  const outPath = path.join(OUTDIR, `${base}-compressed.pdf`);

  try {
    const tries = [
      { pdfsettings: "/ebook", colorRes: 144, grayRes: 144, monoRes: 144 },
      { pdfsettings: "/screen", colorRes: 120, grayRes: 120, monoRes: 120 },
      { pdfsettings: "/screen", colorRes: 96, grayRes: 96, monoRes: 96 }
    ];
    for (const t of tries) {
      await runGhostscript(inPath, outPath, t);
      const size = fs.existsSync(outPath) ? fs.statSync(outPath).size : Infinity;
      if (size <= targetKb * 1024) break;
      fs.copyFileSync(outPath, inPath);
    }
    if (!fs.existsSync(outPath)) throw new Error("No output file");
    const buf = fs.readFileSync(outPath);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="compressed.pdf"');
    res.send(buf);
  } catch (e) {
    console.error("pdf compress error:", e);
    res.status(500).json({ error: "Failed to compress PDF" });
  } finally {
    try { fs.unlinkSync(inPath); } catch {}
    try { fs.unlinkSync(outPath); } catch {}
  }
});

// Images -> PDF
app.post("/api/convert/images-to-pdf", upload.array("files"), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "Please upload at least one image." });
    }
    const pdfDoc = await PDFDocument.create();
    for (const f of req.files) {
      const bytes = fs.readFileSync(f.path);
      let img;
      if ((f.mimetype || "").includes("jpeg") || f.originalname.toLowerCase().endsWith(".jpg")) img = await pdfDoc.embedJpg(bytes);
      else if ((f.mimetype || "").includes("png") || f.originalname.toLowerCase().endsWith(".png")) img = await pdfDoc.embedPng(bytes);
      else { try { img = await pdfDoc.embedJpg(bytes); } catch { img = await pdfDoc.embedPng(bytes); } }
      const dims = img.scale(1);
      const A4 = { w: 595.28, h: 841.89 }, margin = 24;
      const maxW = A4.w - margin * 2, maxH = A4.h - margin * 2;
      const scale = Math.min(maxW / dims.width, maxH / dims.height, 1);
      const w = dims.width * scale, h = dims.height * scale;
      const x = (A4.w - w) / 2, y = (A4.h - h) / 2;
      const page = pdfDoc.addPage([A4.w, A4.h]);
      page.drawImage(img, { x, y, width: w, height: h });
    }
    const out = await pdfDoc.save();
    for (const f of req.files) { try { fs.unlinkSync(f.path); } catch {} }
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="images.pdf"');
    res.send(Buffer.from(out));
  } catch (e) {
    console.error("images->pdf error:", e);
    res.status(500).json({ error: "Failed to build PDF from images" });
  }
});

// PDF -> images (ZIP)
app.post("/api/convert/pdf-to-images", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  const pdfPath = req.file.path;
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "pdfimgs-"));
  const prefix = path.join(tmpDir, "page");

  try {
    const args = ["-png", "-rx", "144", "-ry", "144", pdfPath, prefix];
    await new Promise((resolve, reject) => {
      const p = spawn("pdftoppm", args);
      let err = "";
      p.stderr.on("data", (d) => (err += d.toString()));
      p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err || `pdftoppm exited ${code}`))));
      p.on("error", reject);
    });
    const files = fs.readdirSync(tmpDir)
      .filter((f) => f.endsWith(".png"))
      .sort((a, b) => parseInt(a.split("-").pop(), 10) - parseInt(b.split("-").pop(), 10));
    if (files.length === 0) throw new Error("No images generated from PDF.");

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", 'attachment; filename="pages.zip"');

    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("error", (err) => { throw err; });
    archive.pipe(res);
    for (const f of files) archive.file(path.join(tmpDir, f), { name: f });
    await archive.finalize();
  } catch (e) {
    console.error("pdf->images error:", e);
    res.status(500).json({ error: "Failed to convert PDF to images" });
  } finally {
    try { fs.unlinkSync(pdfPath); } catch {}
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

// ---------- PRO: PDF -> DOCX via CloudConvert + Gumroad ----------

// 1) Prepare job and return a ticket (Frontend: then open Gumroad with fields[ticket]=TICKET)
app.post("/api/pro/prepare", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const isPdf = (req.file.mimetype === "application/pdf") || req.file.originalname.toLowerCase().endsWith(".pdf");
    if (!isPdf) return res.status(400).json({ error: "Please upload a PDF" });

    const ticket = randomUUID().replace(/-/g, "");
    const filename = req.file.originalname || "input.pdf";
    const filePath = req.file.path;

    // Create CC job: import/upload -> convert -> export/url
    const job = await cloudConvert.jobs.create({
      tasks: {
        "import-1": { operation: "import/upload" },
        "convert-1": {
          operation: "convert",
          input: "import-1",
          input_format: "pdf",
          output_format: "docx",
          // You can tune options here if needed (OCR, etc.)
        },
        "export-1": { operation: "export/url", input: "convert-1" }
      }
    });

    // Upload the file to the import task
    const uploadTask = job.tasks.find(t => t.name === "import-1");
    await cloudConvert.tasks.upload(uploadTask, fs.createReadStream(filePath), filename);
    try { fs.unlinkSync(filePath); } catch {}

    // Store ticket
    tickets.set(ticket, { paid: false, ready: false, jobId: job.id, file: null, createdAt: Date.now() });

    console.log("PRO PREPARED:", { ticket, jobId: job.id, filename });
    res.json({ ticket });
  } catch (e) {
    console.error("pro/prepare error:", e);
    res.status(500).json({ error: "Failed to prepare conversion" });
  }
});

// 2) Gumroad webhook (marks ticket as paid)
function toCents(val) {
  if (val == null) return NaN;
  const s = String(val).trim();
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const n = Number(s);
  if (!Number.isFinite(n)) return NaN;
  return Math.round(n * 100);
}

app.post("/api/gumroad/ping", (req, res) => {
  try {
    console.log("GUMROAD PING BODY:", req.body);

    const expected = (process.env.GUMROAD_PRODUCT_PERMALINK || "").trim();
    const pp = String(req.body.product_permalink || req.body.permalink || "").trim();
    const ppSlug = pp.includes("/l/") ? pp.split("/l/").pop() : pp.split("/").pop();

    const cents = toCents(req.body.price);
    const minCents = parseInt(process.env.GUMROAD_MIN_PRICE_CENTS || "199", 10);
    const isRefunded = String(req.body.refunded || "").toLowerCase() === "true";

    let params = {};
    if (typeof req.body.url_params === "string") { try { params = JSON.parse(req.body.url_params); } catch {} }
    else if (req.body.url_params && typeof req.body.url_params === "object") { params = req.body.url_params; }

    const cfTicket = req.body?.custom_fields?.ticket;
    const cfTicketAlt = req.body['custom_fields[ticket]'];
    const ticket = (params.ticket || cfTicket || cfTicketAlt || "").toString();

    if (ppSlug !== expected && pp !== expected) { console.warn("PING: wrong product", { pp, ppSlug, expected }); return res.status(200).send("Wrong product"); }
    if (!Number.isFinite(cents))                  { console.warn("PING: bad price", { raw: req.body.price });      return res.status(200).send("Bad price"); }
    if (cents < minCents)                         { console.warn("PING: underpaid", { cents, minCents });          return res.status(200).send("Underpaid"); }
    if (isRefunded)                               { console.warn("PING: refunded");                                 return res.status(200).send("Refunded"); }
    if (!ticket)                                  { console.warn("PING: missing ticket");                           return res.status(200).send("No ticket"); }
    if (!tickets.has(ticket))                     { console.warn("PING: no matching ticket", { ticket });           return res.status(200).send("No matching ticket"); }

    tickets.get(ticket).paid = true;
    console.log("PING: success, ticket paid", { ticket, cents });
    return res.status(200).send("OK");
  } catch (e) {
    console.error("gumroad/ping error:", e);
    return res.status(200).send("OK"); // don't force retries
  }
});

// Gumroad reconciliation (if webhook missed)
async function reconcileGumroadPayment(ticket) {
  try {
    const token = process.env.GUMROAD_ACCESS_TOKEN;
    if (!token) return false;
    const permalink = process.env.GUMROAD_PRODUCT_PERMALINK;
    const since = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const url = `https://api.gumroad.com/v2/sales?access_token=${encodeURIComponent(token)}&product_permalink=${encodeURIComponent(permalink)}&after=${encodeURIComponent(since)}`;
    const { data } = await axios.get(url);
    const sales = data?.sales || [];
    for (const s of sales) {
      const refunded = String(s.refunded || "").toLowerCase() === "true";
      const ticketInSale =
        (s.url_params && (s.url_params.ticket || s.url_params.TICKET)) ||
        (s.custom_fields && s.custom_fields.ticket);
      if (!refunded && ticketInSale === ticket) return true;
    }
  } catch (e) {
    console.warn("reconcileGumroadPayment error:", e.message);
  }
  return false;
}

// 3) Status: no-cache + self-heal (payment + CC readiness)
app.get("/api/pro/status", async (req, res) => {
  const ticket = String(req.query.ticket || "");
  const rec = tickets.get(ticket);
  if (!rec) return res.status(404).json({ error: "Invalid ticket" });

  // never cache status
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  res.set("Surrogate-Control", "no-store");

  // Self-heal CC readiness (even if waiter missed)
  try {
    if (!rec.ready && rec.jobId) {
      const job = await cloudConvert.jobs.get(rec.jobId);
      const files = cloudConvert.jobs.getExportUrls(job);
      if (files && files[0]) {
        rec.ready = true;
        rec.file = files[0];
        console.log("STATUS: CC ready via refresh", { ticket, filename: files[0].filename });
      }
    }
  } catch { /* ignore */ }

  // Self-heal payment via Gumroad Sales API
  try {
    if (!rec.paid) {
      const paidNow = await reconcileGumroadPayment(ticket);
      if (paidNow) {
        rec.paid = true;
        console.log("STATUS: payment reconciled from Gumroad API", { ticket });
      }
    }
  } catch { /* ignore */ }

  return res.status(200).json({ paid: rec.paid, ready: rec.ready, error: rec.error || null });
});

// 4) Download: only when paid & ready
app.get("/api/pro/download", async (req, res) => {
  try {
    const ticket = String(req.query.ticket || "");
    const rec = tickets.get(ticket);
    if (!rec) return res.status(404).json({ error: "Invalid ticket" });
    if (!rec.paid) return res.status(402).json({ error: "Payment required" });
    if (!rec.ready || !rec.file) return res.status(425).json({ error: "Not ready yet" });

    // Fetch file from CloudConvert export URL and stream it
    const fileUrl = rec.file.url;
    const filename = rec.file.filename || "converted.docx";
    const resp = await axios.get(fileUrl, { responseType: "arraybuffer" });

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    return res.send(Buffer.from(resp.data));
  } catch (e) {
    console.error("pro/download error:", e);
    return res.status(500).json({ error: "Download failed" });
  }
});

// ---------- Debug helpers (optional; remove later) ----------

// View a ticket record
app.get("/api/pro/debug/ticket", (req, res) => {
  const t = String(req.query.ticket || "");
  const rec = tickets.get(t);
  if (!rec) return res.status(404).json({ error: "No such ticket" });
  res.json({ ticket: t, ...rec });
});

// Query CloudConvert job tasks
app.get("/api/pro/debug/cc", async (req, res) => {
  try {
    const t = String(req.query.ticket || "");
    const rec = tickets.get(t);
    if (!rec) return res.status(404).json({ error: "No such ticket" });
    const job = await cloudConvert.jobs.get(rec.jobId);
    res.json({
      ticket: t,
      jobId: rec.jobId,
      status: job.status,
      tasks: job.tasks?.map(x => ({ name: x.name, status: x.status, result: x.result }))
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Force mark paid (ONLY for debugging; guard with secret to be safe)
app.post("/api/pro/force-paid", (req, res) => {
  const t = String(req.query.ticket || "");
  const secret = String(req.query.secret || "");
  if (process.env.FORCE_ADMIN_SECRET && secret !== process.env.FORCE_ADMIN_SECRET) {
    return res.status(403).json({ error: "forbidden" });
  }
  const rec = tickets.get(t);
  if (!rec) return res.status(404).json({ error: "invalid ticket" });
  rec.paid = true;
  return res.json({ ok: true });
});

// ---------- debug route from original ----------
app.get("/api/debug/soffice", (_req, res) => {
  const ls = p => (fs.existsSync(p) ? fs.readdirSync(p) : []);
  res.json({
    resolved: SOFFICE_CMD,
    exists: fs.existsSync(SOFFICE_CMD),
    candidates: {
      "/usr/bin": ls("/usr/bin"),
      "/usr/lib/libreoffice/program": ls("/usr/lib/libreoffice/program"),
    },
    PATH: process.env.PATH
  });
});

// ---------- start ----------
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Backend running on :${PORT}`));
