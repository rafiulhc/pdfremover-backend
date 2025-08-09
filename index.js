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

// ==== NEW: CloudConvert + helpers ====
const CloudConvert = require("cloudconvert");
const axios = require("axios");
const { randomUUID } = require("crypto");

const cloudConvert = new CloudConvert(process.env.CLOUDCONVERT_API_KEY || "");
const GUMROAD_PRODUCT_PERMALINK = process.env.GUMROAD_PRODUCT_PERMALINK || "pdf2docx-pro";
const GUMROAD_MIN_PRICE_CENTS = parseInt(process.env.GUMROAD_MIN_PRICE_CENTS || "199", 10);

// tickets: memory map (fine for single dyno). If you use multiple dynos, move this to Redis.
const tickets = new Map();
/*
tickets.set(ticketId, {
  jobId, paid:false, ready:false, file:{url, filename} | null, createdAt:number, error:string|null
});
*/

// ---------- basics ----------
app.use(cors({
  origin: [
    "http://localhost:3000",
    "https://pdfremover-frontend.vercel.app",
    "https://pdfmergersplitter.app",
    "https://www.pdfmergersplitter.app"
  ],
  methods: ["POST", "GET", "OPTIONS"], // <--- GET added
  allowedHeaders: ["Content-Type"]
}));

const OUTDIR = path.join(process.cwd(), "uploads");
fs.mkdirSync(OUTDIR, { recursive: true });

const upload = multer({ dest: OUTDIR });

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

/* ---------- routes (existing) ---------- */

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

/** PDF -> DOCX (LibreOffice basic) */
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

// ---------- debug route (existing) ----------
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
    child.on("close", code => {
      if (code === 0) return resolve();
      reject(new Error(`Ghostscript exited ${code}: ${stderr}`));
    });
  });
}

/** compress image */
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
      const candidateWidth =
        attempt < 4 ? width : Math.max(600, Math.floor(width * Math.pow(0.85, attempt - 3)));

      let pipeline = sharp(input).resize(candidateWidth, null, { fit: "inside", withoutEnlargement: true });

      if (format === "webp") {
        pipeline = pipeline.webp({ quality, effort: 4 });
      } else if (format === "jpeg") {
        pipeline = pipeline.flatten({ background: "#ffffff" }).jpeg({ quality, mozjpeg: true });
      } else if (format === "png") {
        pipeline = pipeline.png({ compressionLevel: 9, palette: true });
      }

      outBuf = await pipeline.toBuffer();

      if (outBuf.length <= targetKb * 1024) break;
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

/** compress pdf */
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

/** images -> pdf */
app.post("/api/convert/images-to-pdf", upload.array("files"), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "Please upload at least one image." });
    }

    const pdfDoc = await PDFDocument.create();

    for (const f of req.files) {
      const bytes = fs.readFileSync(f.path);
      let img, dims;

      if ((f.mimetype || "").includes("jpeg") || f.originalname.toLowerCase().endsWith(".jpg")) {
        img = await pdfDoc.embedJpg(bytes);
      } else if ((f.mimetype || "").includes("png") || f.originalname.toLowerCase().endsWith(".png")) {
        img = await pdfDoc.embedPng(bytes);
      } else {
        try { img = await pdfDoc.embedJpg(bytes); } catch {
          img = await pdfDoc.embedPng(bytes);
        }
      }
      dims = img.scale(1);

      const A4 = { w: 595.28, h: 841.89 };
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

    for (const f of req.files) { try { fs.unlinkSync(f.path); } catch {} }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="images.pdf"');
    res.send(Buffer.from(out));
  } catch (e) {
    console.error("images->pdf error:", e);
    res.status(500).json({ error: "Failed to build PDF from images" });
  }
});

/** pdf -> images (zip) */
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
      archive.file(p, { name: f });
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

// ===================== NEW: PRO (CloudConvert + Gumroad) =====================

// Start a paid high-fidelity PDF->DOCX via CloudConvert; returns ticket + buyUrl
app.post("/api/pro/prepare", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  if (!process.env.CLOUDCONVERT_API_KEY) return res.status(500).json({ error: "CloudConvert not configured" });

  const ticket = randomUUID().replace(/-/g, "");
  const origName = req.file.originalname || "input.pdf";

  try {
    const job = await cloudConvert.jobs.create({
      tasks: {
        'import-1': { operation: 'import/upload' },
        'convert-1': {
          operation: 'convert',
          input: 'import-1',
          input_format: 'pdf',
          output_format: 'docx'
        },
        'export-1': { operation: 'export/url', input: 'convert-1' }
      }
    });

    const uploadTask = job.tasks.find(t => t.name === 'import-1');
    await cloudConvert.tasks.upload(
      uploadTask,
      fs.createReadStream(req.file.path),
      origName
    );

    try { fs.unlinkSync(req.file.path); } catch {}

    tickets.set(ticket, {
      jobId: job.id,
      paid: false,
      ready: false,
      file: null,
      createdAt: Date.now(),
      error: null
    });

    // async waiter
    (async () => {
      try {
        const finished = await cloudConvert.jobs.wait(job.id);
        const files = cloudConvert.jobs.getExportUrls(finished);
        const file = files && files[0];
        const rec = tickets.get(ticket);
        if (rec) {
          rec.ready = !!file;
          rec.file = file || null;
          if (!file) rec.error = "No export URL from CloudConvert";
        }
      } catch (e) {
        const rec = tickets.get(ticket);
        if (rec) rec.error = e.message || "CloudConvert failed";
      }
    })();

    const buyUrl = `https://gumroad.com/l/${encodeURIComponent(GUMROAD_PRODUCT_PERMALINK)}?wanted=true&ticket=${encodeURIComponent(ticket)}`;
    return res.json({ ticket, buyUrl });
  } catch (e) {
    console.error("pro/prepare error:", e);
    try { fs.unlinkSync(req.file.path); } catch {}
    return res.status(500).json({ error: "Failed to initialize conversion" });
  }
});

// OPTIONAL: disable etag globally (prevents 304s)
// app.set('etag', false);

app.get("/api/pro/status", (req, res) => {
  const ticket = String(req.query.ticket || "");
  const rec = tickets.get(ticket);
  if (!rec) return res.status(404).json({ error: "Invalid ticket" });

  // no-cache everywhere
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  res.set("Surrogate-Control", "no-store");

  res.status(200).json({
    paid: rec.paid,
    ready: rec.ready,
    error: rec.error || null
  });
});


// Download if paid and ready (proxy stream from CloudConvert URL)
app.get("/api/pro/download", async (req, res) => {
  const ticket = String(req.query.ticket || "");
  const rec = tickets.get(ticket);
  if (!rec) return res.status(404).json({ error: "Invalid ticket" });
  if (rec.error) return res.status(500).json({ error: rec.error });
  if (!rec.paid) return res.status(402).json({ error: "Payment required" });
  if (!rec.ready || !rec.file?.url) return res.status(425).json({ error: "Conversion not ready yet" });

  try {
    const filename = (rec.file.filename || "converted.docx").replace(/[/\\]/g, "_");
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

    const stream = await axios.get(rec.file.url, { responseType: "stream" });
    stream.data.pipe(res);
  } catch (e) {
    console.error("download error:", e);
    res.status(500).json({ error: "Failed to fetch file" });
  }
});

// Gumroad Ping webhook (mark ticket as paid)
app.use("/api/gumroad/ping", express.urlencoded({ extended: true }));
app.post("/api/gumroad/ping", (req, res) => {
  try {
    const { product_permalink, price, refunded, url_params } = req.body;

    if ((product_permalink || "").split("/").pop() !== GUMROAD_PRODUCT_PERMALINK) {
      return res.status(400).send("Wrong product");
    }
    const cents = parseInt(price || "0", 10);
    if (Number.isNaN(cents) || cents < GUMROAD_MIN_PRICE_CENTS) {
      return res.status(400).send("Underpaid");
    }
    if (String(refunded || "").toLowerCase() === "true") {
      return res.status(200).send("Ignored (refunded)");
    }

    let params = {};
    if (typeof url_params === "string") {
      try { params = JSON.parse(url_params); } catch { params = {}; }
    } else if (typeof url_params === "object" && url_params) {
      params = url_params;
    }

    const ticket = params.ticket;
    if (!ticket || !tickets.has(ticket)) {
      return res.status(200).send("No matching ticket");
    }

    const rec = tickets.get(ticket);
    rec.paid = true;

    return res.status(200).send("OK");
  } catch (e) {
    console.error("gumroad/ping error:", e);
    return res.status(500).send("Ping handler error");
  }
});

// Show what we know about a ticket
app.get("/api/pro/debug/ticket", (req, res) => {
  const t = String(req.query.ticket || "");
  const rec = tickets.get(t);
  if (!rec) return res.status(404).json({ error: "No such ticket" });
  res.json({ ticket: t, ...rec });
});

// (Optional) Ask CloudConvert directly about the job
app.get("/api/pro/debug/cc", async (req, res) => {
  try {
    const t = String(req.query.ticket || "");
    const rec = tickets.get(t);
    if (!rec) return res.status(404).json({ error: "No such ticket" });
    const job = await cloudConvert.jobs.get(rec.jobId);
    res.json({ ticket: t, jobId: rec.jobId, status: job.status, tasks: job.tasks?.map(x => ({ name: x.name, status: x.status, result: x.result })) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// ---------- start ----------
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Backend running on :${PORT}`));
