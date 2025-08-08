const express = require("express");
const multer = require("multer");
const cors = require("cors");
const { PDFDocument } = require("pdf-lib");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const app = express();
const { execFile } = require("child_process");

const fs = require("fs");
const { spawn } = require("child_process");

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

const upload = multer({ dest: "uploads/" });

/**
 * 📄 Remove Pages from PDF
 */
app.post("/api/remove-pages", upload.single("file"), async (req, res) => {
  try {
    const filePath = req.file.path;
    const buffer = fs.readFileSync(filePath);

    const pagesToRemove = (req.body.pagesToRemove || "")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean)
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

    fs.unlinkSync(filePath);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="cleaned.pdf"');
    res.send(Buffer.from(outBytes));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Processing failed" });
  }
});

/**
 * 📄 Merge PDFs
 */
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
      fs.unlinkSync(file.path);
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


  /**
   * DOCX -> PDF via LibreOffice
   */
  app.post("/api/convert/docx-to-pdf", upload.single("file"), async (req, res) => {
    const tmpPath = req.file?.path;
    if (!tmpPath) return res.status(400).json({ error: "No file uploaded" });

    const origName = req.file.originalname || "input.docx";
    const baseNoExt = path.parse(origName).name;
    const outDir = path.join(process.cwd(), "uploads");

    try {
      await runSoffice([
        "--headless","--nologo","-env:UserInstallation=file:///tmp/lo_profile",
        "--convert-to","pdf","--outdir", outDir, tmpPath
      ]);

      const outFile = findConverted(outDir, baseNoExt, "pdf") || findConverted(outDir, path.parse(tmpPath).name, "pdf");
      if (!outFile || !fs.existsSync(outFile)) throw new Error("Conversion output not found");

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", 'attachment; filename="converted.pdf"');
      res.send(fs.readFileSync(outFile));
    } catch (e) {
      console.error("docx->pdf error:", e.message);
      res.status(500).json({ error: e.message.includes("soffice") ? "Converter not available on server" : `Conversion failed: ${e.message}` });
    } finally {
      try { fs.unlinkSync(tmpPath); } catch {}
      try {
        const outFile = findConverted(outDir, baseNoExt, "pdf") || findConverted(outDir, path.parse(tmpPath).name, "pdf");
        if (outFile) fs.unlinkSync(outFile);
      } catch {}
    }
  });

  /**
   * PDF -> DOCX via LibreOffice
   * NOTE: quality varies depending on the PDF (vector text vs scanned/complex layout).
   */
  app.post("/api/convert/pdf-to-docx", upload.single("file"), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const tmpPath = req.file.path;                 // e.g. uploads/xyz789
    const origName = req.file.originalname || "input.pdf";
    const baseNoExt = path.parse(origName).name;
    const outDir = path.join(process.cwd(), "uploads");

    try {
      await runSoffice(["--headless", "--nologo", "--convert-to", "docx", "--outdir", outDir, tmpPath]);

      const outFile = findConverted(outDir, baseNoExt, "docx") || findConverted(outDir, path.parse(tmpPath).name, "docx");
      if (!outFile || !fs.existsSync(outFile)) throw new Error("Conversion output not found");

      const bytes = fs.readFileSync(outFile);
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
      res.setHeader("Content-Disposition", 'attachment; filename="converted.docx"');
      res.send(bytes);
    } catch (e) {
      console.error("pdf->docx error:", e.message);
      res.status(500).json({ error: "Conversion failed: " + e.message });
    } finally {
      fs.unlink(tmpPath, () => {});
      try {
        const outFile = findConverted(outDir, baseNoExt, "docx") || findConverted(outDir, path.parse(tmpPath).name, "docx");
        if (outFile) fs.unlink(outFile, () => {});
      } catch {}
    }
  });

  app.get("/api/debug/soffice", (_req, res) => {
  execFile("which", ["soffice"], (err, stdout, stderr) => {
    res.json({
      which: stdout.trim() || null,
      err: err ? err.message : null,
      stderr: (stderr || "").toString(),
      envHOME: process.env.HOME || null,
    });
  });
});

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


const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Backend running on :${PORT}`));
