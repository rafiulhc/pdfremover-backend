const express = require("express");
const multer = require("multer");
const cors = require("cors");
const { PDFDocument } = require("pdf-lib");
const fs = require("fs");
const path = require("path");

const app = express();

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

function runSoffice(args) {
    return new Promise((resolve, reject) => {
      execFile("soffice", args, { timeout: 120000 }, (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || stdout || err.message));
        resolve({ stdout, stderr });
      });
    });
  }

  // Find the newest file in a directory that matches a base name (Heroku temp)
  function findConverted(outDir, baseNoExt, targetExt) {
    const files = fs.readdirSync(outDir)
      .filter(f => f.toLowerCase().endsWith(`.${targetExt}`) && f.startsWith(baseNoExt));
    if (!files.length) return null;
    // pick the newest by mtime
    let newest = files[0];
    let newestTime = fs.statSync(path.join(outDir, newest)).mtimeMs;
    for (const f of files) {
      const t = fs.statSync(path.join(outDir, f)).mtimeMs;
      if (t > newestTime) { newest = f; newestTime = t; }
    }
    return path.join(outDir, newest);
  }

  /**
   * DOCX -> PDF via LibreOffice
   */
  app.post("/api/convert/docx-to-pdf", upload.single("file"), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const tmpPath = req.file.path;                 // e.g. uploads/abc123
    const origName = req.file.originalname || "input.docx";
    const baseNoExt = path.parse(origName).name;
    const outDir = path.join(process.cwd(), "uploads"); // write output next to input

    try {
      // Convert with LibreOffice
      // --headless: no UI; --nologo: faster; --convert-to pdf
      await runSoffice(["--headless", "--nologo", "--convert-to", "pdf", "--outdir", outDir, tmpPath]);

      const outFile = findConverted(outDir, baseNoExt, "pdf") || findConverted(outDir, path.parse(tmpPath).name, "pdf");
      if (!outFile || !fs.existsSync(outFile)) throw new Error("Conversion output not found");

      const bytes = fs.readFileSync(outFile);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", 'attachment; filename="converted.pdf"');
      res.send(bytes);
    } catch (e) {
      console.error("docx->pdf error:", e.message);
      res.status(500).json({ error: "Conversion failed: " + e.message });
    } finally {
      // cleanup
      fs.unlink(tmpPath, () => {});
      // optional: delete output file to keep slug clean
      try {
        const outFile = findConverted(outDir, baseNoExt, "pdf") || findConverted(outDir, path.parse(tmpPath).name, "pdf");
        if (outFile) fs.unlink(outFile, () => {});
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

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Backend running on :${PORT}`));
