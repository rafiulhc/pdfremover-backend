// index.js
const express = require("express");
const multer = require("multer");
const cors = require("cors");
const { PDFDocument } = require("pdf-lib");
const fs = require("fs");
const path = require("path");
const { spawn, execFile } = require("child_process");
const sharp = require("sharp");
const app = express();
const archiver = require("archiver");
const { mkdtempSync, rmSync } = require("fs");
const os = require("os");
const { pdfQueue } = require('./queue');
const { v4: uuid } = require('uuid');
// Job status
const { Queue } = require('bullmq');
const { connection } = require('./queue');
const statusQ = new Queue('pdf-jobs', { connection });
// top of file
const { buildQueue, connection } = require('./queue');
const IORedis = require('ioredis');
const axios = require('axios');
const redis = new IORedis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false
});
const multer = require('multer');
const upload = multer({ dest: path.join(process.cwd(), 'uploads') });

const { q: premiumQ } = buildQueue('cc-pdf2docx');


/* ---------- basics ---------- */
app.use(cors({
  origin: [
    "http://localhost:3000",
    "https://pdfremover-frontend.vercel.app",
    "https://pdfmergersplitter.app",
    "https://www.pdfmergersplitter.app"
  ],
  methods: ["POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"]
}));

const OUTDIR = path.join(process.cwd(), "uploads");
fs.mkdirSync(OUTDIR, { recursive: true });

const { Queue } = require('bullmq');


app.get('/api/jobs/premium/:id', async (req, res) => {
  const job = await statusQ.getJob(req.params.id);
  if (!job) return res.status(404).json({ status: 'not_found' });
  const state = await job.getState();
  const result = state === 'completed' ? job.returnvalue : null;
  res.json({ status: state, result });
});

app.get('/api/download', (req, res) => {
  const p = req.query.p;
  if (!p || typeof p !== 'string') return res.status(400).send('bad path');
  // (optional) add a whitelist: p must begin with /tmp
  res.download(p);
});


/* ---------- helpers ---------- */
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
  return "soffice"; // fall back to PATH
}
const SOFFICE_CMD = resolveSofficeBin();
console.log("Resolved soffice path:", SOFFICE_CMD);

function runSoffice(args, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(SOFFICE_CMD, args, {
      env: { ...process.env, HOME: process.env.HOME || "/tmp" },
    });
    let stderr = "", stdout = "";
    const to = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} ; reject(new Error(`LibreOffice timeout after ${timeoutMs}ms`)); }, timeoutMs);

    child.stdout.on("data", d => (stdout += d.toString()));
    child.stderr.on("data", d => (stderr += d.toString()));
    child.on("error", err => { clearTimeout(to); reject(new Error(`Failed to start soffice (${SOFFICE_CMD}): ${err.message}`)); });
    child.on("close", code => {
      clearTimeout(to);
      if (code === 0) return resolve({ stdout, stderr });
      reject(new Error(`soffice exited with code ${code}\n${stderr || stdout}`));
    });
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

// Enqueue merge (job version)
app.post("/api/jobs/merge", upload.array("files"), async (req, res) => {
  try {
    const uploadPaths = (req.files || []).map(f => f.path);
    if (uploadPaths.length < 2) return res.status(400).json({ error: "Please upload at least two PDF files." });

    const jobId = uuid();
    await pdfQueue.add('merge', { uploadPaths, outName: 'merged.pdf' }, { jobId });
    res.json({ jobId });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "enqueue_failed" });
  }
});

// Enqueue remove (job version)
app.post("/api/jobs/remove", upload.single("file"), async (req, res) => {
  try {
    const removeIndices = (req.body.pagesToRemove || "")
      .split(",").map(s => s.trim()).filter(Boolean)
      .map(n => parseInt(n, 10) - 1);

    const jobId = uuid();
    await pdfQueue.add('remove', { uploadPath: req.file.path, removeIndices, outName: 'cleaned.pdf' }, { jobId });
    res.json({ jobId });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "enqueue_failed" });
  }
});

// Enqueue docx->pdf (job version)
app.post("/api/jobs/docx-to-pdf", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const jobId = uuid();
    await pdfQueue.add('docx-to-pdf', { uploadPath: req.file.path, origName: req.file.originalname }, { jobId });
    res.json({ jobId });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "enqueue_failed" });
  }
});



app.get("/api/jobs/:id", async (req, res) => {
  const job = await statusQ.getJob(req.params.id);
  if (!job) return res.status(404).json({ status: "not_found" });
  const state = await job.getState();
  const result = state === "completed" ? job.returnvalue : null;
  res.json({ status: state, result });
});

// Simple download proxy if you return a local path (optional)
app.get("/api/download", (req, res) => {
  const p = req.query.p;
  if (!p || typeof p !== 'string') return res.status(400).send('bad path');
  // TODO: add validation so only /tmp or /uploads paths are allowed
  res.download(p);
});


/* ---------- routes ---------- */

/** Remove pages */
app.post("/api/remove-pages", upload.single("file"), async (req, res) => {
  try {
    const filePath = req.file.path;
    const buffer = fs.readFileSync(filePath);

    const pagesToRemove = (req.body.pagesToRemove || "")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean)
      .map(n => parseInt(n, 10) - 1); // zero-based

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

/** Merge PDFs */
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

/** DOCX -> PDF */
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

/** PDF -> DOCX (layout quality depends on source PDF) */
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

/* ---------- single debug route (keep while troubleshooting) ---------- */
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

function runGhostscript(inputPath, outputPath, opts = {}) {
    return new Promise((resolve, reject) => {
      const {
        pdfsettings = "/ebook", // /screen (smallest), /ebook, /printer, /prepress
        colorRes = 120,         // dpi downsample target
        grayRes = 120,
        monoRes = 120
      } = opts;

      // Common GS flags for size reduction
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
      child.on("close", code => {
        if (code === 0) return resolve();
        reject(new Error(`Ghostscript exited ${code}: ${stderr}`));
      });
    });
  }

  /**
   * POST /api/compress/image
   * Form: file (image), targetKb? (default 500)
   * Output: webp (image/webp)
   */
  // POST /api/compress/image
// form-data: file, targetKb (optional), format (optional: webp|jpeg|png)
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

      let quality = 82;             // used for webp/jpeg
      let attempt = 0;
      let outBuf = null;

      while (attempt < 10) {
        const candidateWidth =
          attempt < 4 ? width : Math.max(600, Math.floor(width * Math.pow(0.85, attempt - 3)));

        let pipeline = sharp(input).resize(candidateWidth, null, { fit: "inside", withoutEnlargement: true });

        if (format === "webp") {
          pipeline = pipeline.webp({ quality, effort: 4 });
        } else if (format === "jpeg") {
          // JPEG can’t do transparency — flatten to white so you don’t get black boxes
          pipeline = pipeline.flatten({ background: "#ffffff" }).jpeg({ quality, mozjpeg: true });
        } else if (format === "png") {
          // PNG doesn’t have “quality”; use palette + max compression (size driven by dimensions)
          pipeline = pipeline.png({ compressionLevel: 9, palette: true });
        }

        outBuf = await pipeline.toBuffer();

        if (outBuf.length <= targetKb * 1024) break;

        // If too big: drop quality for webp/jpeg, else keep reducing width
        if (format === "webp" || format === "jpeg") {
          quality = Math.max(45, quality - 8);
        }
        attempt++;
      }

      const ct =
        format === "webp" ? "image/webp" :
        format === "jpeg" ? "image/jpeg" : "image/png";
      const ext =
        format === "webp" ? "webp" :
        format === "jpeg" ? "jpg" : "png";

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


  /**
   * POST /api/compress/pdf
   * Form: file (pdf), targetKb? (default 500)
   * Output: application/pdf
   */
  app.post("/api/compress/pdf", upload.single("file"), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const targetKb = Math.max(100, parseInt(req.body.targetKb || "500", 10)); // floor 100KB for legibility

    const inPath = req.file.path;
    const base = path.parse(inPath).name;
    const outPath = path.join(OUTDIR, `${base}-compressed.pdf`);

    try {
      // Iteratively try tighter presets/resolutions
      const tries = [
        { pdfsettings: "/ebook", colorRes: 144, grayRes: 144, monoRes: 144 },
        { pdfsettings: "/screen", colorRes: 120, grayRes: 120, monoRes: 120 },
        { pdfsettings: "/screen", colorRes: 96, grayRes: 96, monoRes: 96 }
      ];

      let ok = false;
      for (const t of tries) {
        await runGhostscript(inPath, outPath, t);
        const size = fs.existsSync(outPath) ? fs.statSync(outPath).size : Infinity;
        if (size <= targetKb * 1024) { ok = true; break; }

        // If still too large, feed the output back in for another pass
        fs.copyFileSync(outPath, inPath);
      }

      if (!fs.existsSync(outPath)) throw new Error("No output file");
      const buf = fs.readFileSync(outPath);

      // We return the best effort even if slightly above target
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

  // routes: add near your other endpoints
app.post("/api/convert/images-to-pdf", upload.array("files"), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "Please upload at least one image." });
    }

    const pdfDoc = await PDFDocument.create();

    for (const f of req.files) {
      const bytes = fs.readFileSync(f.path);
      let img, dims;

      // Try embed as JPEG first, fallback to PNG
      if ((f.mimetype || "").includes("jpeg") || f.originalname.toLowerCase().endsWith(".jpg")) {
        img = await pdfDoc.embedJpg(bytes);
      } else if ((f.mimetype || "").includes("png") || f.originalname.toLowerCase().endsWith(".png")) {
        img = await pdfDoc.embedPng(bytes);
      } else {
        // generic attempt: try JPG then PNG
        try { img = await pdfDoc.embedJpg(bytes); } catch {
          img = await pdfDoc.embedPng(bytes);
        }
      }
      dims = img.scale(1);

      // A4 in points
      const A4 = { w: 595.28, h: 841.89 };
      // Fit image into A4 (with 24pt margin)
      const margin = 24;
      const maxW = A4.w - margin * 2;
      const maxH = A4.h - margin * 2;

      const scale = Math.min(maxW / dims.width, maxH / dims.height, 1);
      const w = dims.width * scale;
      const h = dims.height * scale;
      const x = (A4.w - w) / 2;
      const y = (A4.h - h) / 2;

      const page = pdfDoc.addPage([A4.w, A4.h]);
      page.drawImage(img, { x, y, width: w, height: h });
    }

    const out = await pdfDoc.save();

    // cleanup temp files
    for (const f of req.files) { try { fs.unlinkSync(f.path); } catch {} }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="images.pdf"');
    res.send(Buffer.from(out));
  } catch (e) {
    console.error("images->pdf error:", e);
    res.status(500).json({ error: "Failed to build PDF from images" });
  }
});

app.post("/api/convert/pdf-to-images", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  const pdfPath = req.file.path;
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "pdfimgs-"));
  const prefix = path.join(tmpDir, "page"); // pdftoppm will create page-1.png etc.

  try {
    // Render at 144 DPI for balance (change -rx/-ry for quality/speed/size)
    const args = ["-png", "-rx", "144", "-ry", "144", pdfPath, prefix];
    await new Promise((resolve, reject) => {
      const p = spawn("pdftoppm", args);
      let err = "";
      p.stderr.on("data", (d) => (err += d.toString()));
      p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err || `pdftoppm exited ${code}`))));
      p.on("error", reject);
    });

    // Collect generated PNGs (pdftoppm names them like page-1.png, page-2.png)
    const files = fs.readdirSync(tmpDir)
      .filter((f) => f.endsWith(".png"))
      .sort((a, b) => {
        const na = parseInt(a.split("-").pop(), 10);
        const nb = parseInt(b.split("-").pop(), 10);
        return na - nb;
      });

    if (files.length === 0) throw new Error("No images generated from PDF.");

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", 'attachment; filename="pages.zip"');

    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("error", (err) => { throw err; });
    archive.pipe(res);

    for (const f of files) {
      const p = path.join(tmpDir, f);
      archive.file(p, { name: f }); // add as page-1.png, page-2.png, ...
    }
    await archive.finalize();
  } catch (e) {
    console.error("pdf->images error:", e);
    res.status(500).json({ error: "Failed to convert PDF to images" });
  } finally {
    try { fs.unlinkSync(pdfPath); } catch {}
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

// Verify a sale_id belongs to your product and wasn’t refunded/chargeback.
// Also enforce single-use via Redis key "sale_used:<sale_id>"
app.get('/api/pay/verify', async (req, res) => {
  const { sale_id } = req.query;
  if (!sale_id) return res.status(400).json({ valid: false, error: 'missing sale_id' });

  // If you want single use:
  const already = await redis.get(`sale_used:${sale_id}`);
  if (already) return res.json({ valid: false, error: 'sale_id already used' });

  try {
    const url = `https://api.gumroad.com/v2/sales/${sale_id}`;
    const { data } = await axios.get(url, {
      headers: { Authorization: `Bearer ${process.env.GUMROAD_ACCESS_TOKEN}` }
    });

    if (!data?.success) return res.json({ valid: false, error: 'not found' });

    const sale = data.sale;
    const ok =
      sale.product_id === process.env.GUMROAD_PRODUCT_ID &&
      sale.refunded === false &&
      sale.chargebacked === false;

    if (!ok) return res.json({ valid: false, error: 'invalid sale' });

    // reserve (mark as used) now — or you can move this to enqueue step
    await redis.setex(`sale_used:${sale_id}`, 3600 * 24, '1'); // usable once for 24h
    res.json({ valid: true });
  } catch (e) {
    console.error('gumroad verify error', e?.response?.data || e.message);
    res.status(500).json({ valid: false, error: 'verify_failed' });
  }
});

app.post('/api/jobs/premium/pdf-to-docx', upload.single('file'), async (req, res) => {
  try {
    const { sale_id } = req.body;
    if (!sale_id) return res.status(400).json({ error: 'sale_id required' });
    if (!req.file) return res.status(400).json({ error: 'file required' });

    // Ensure sale_id is reserved (created by /api/pay/verify) and not already consumed by a job
    const used = await redis.get(`sale_used:${sale_id}`);
    if (!used) return res.status(400).json({ error: 'sale_id not verified/expired' });

    // Optional: prevent duplicate enqueue
    const consumed = await redis.get(`sale_consumed:${sale_id}`);
    if (consumed) return res.status(400).json({ error: 'sale_id already consumed' });

    const jobId = uuid();
    await premiumQ.add('cc', { uploadPath: req.file.path }, { jobId });

    // mark consumed (so only one job can be created for this sale)
    await redis.setex(`sale_consumed:${sale_id}`, 3600 * 24, jobId);

    res.json({ jobId });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'enqueue_failed' });
  }
});


/* ---------- start ---------- */
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Backend running on :${PORT}`));
