// Free PDF tools: remove pages, merge, compress, images <-> PDF.
const express = require("express");
const fs = require("fs");
const os = require("os");
const path = require("path");
const archiver = require("archiver");
const { PDFDocument } = require("pdf-lib");
const { safeUnlink, safeRmDir, streamFile } = require("../lib/files");
const { runGhostscript, runPdftoppm } = require("../lib/converters");

const A4 = { w: 595.28, h: 841.89 };

function pdfRouter({ upload, heavy, outDir }) {
  const router = express.Router();

  router.post("/api/remove-pages", upload.single("file"), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const filePath = req.file.path;
    try {
      const buffer = fs.readFileSync(filePath);

      const pagesToRemove = (req.body.pagesToRemove || "")
        .split(",").map(s => s.trim()).filter(Boolean).map(n => parseInt(n, 10) - 1);

      const srcPdf = await PDFDocument.load(buffer);
      const total = srcPdf.getPageCount();

      const keepIndices = [];
      for (let i = 0; i < total; i++) if (!pagesToRemove.includes(i)) keepIndices.push(i);

      const outPdf = await PDFDocument.create();
      const copied = await outPdf.copyPages(srcPdf, keepIndices);
      copied.forEach(p => outPdf.addPage(p));
      const outBytes = await outPdf.save();

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", 'attachment; filename="cleaned.pdf"');
      res.send(Buffer.from(outBytes));
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "Processing failed" });
    } finally {
      safeUnlink(filePath);
    }
  });

  router.post("/api/merge-pdfs", upload.array("files"), async (req, res) => {
    try {
      if (!req.files || req.files.length < 2) {
        return res.status(400).json({ error: "Please upload at least two PDF files." });
      }

      const mergedPdf = await PDFDocument.create();
      for (const file of req.files) {
        const pdf = await PDFDocument.load(fs.readFileSync(file.path));
        const copiedPages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
        copiedPages.forEach((page) => mergedPdf.addPage(page));
      }

      const outFile = path.join(outDir, `merged-${Date.now()}-${process.hrtime.bigint()}.pdf`);
      fs.writeFileSync(outFile, await mergedPdf.save());
      streamFile(res, outFile, "merged.pdf", "application/pdf");
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to merge PDFs" });
    } finally {
      for (const f of req.files || []) safeUnlink(f.path);
    }
  });

  router.post("/api/compress/pdf", upload.single("file"), heavy(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const targetKb = Math.max(100, parseInt(req.body.targetKb || "500", 10));

    const inPath = req.file.path;
    const outPath = path.join(outDir, `${path.parse(inPath).name}-compressed.pdf`);

    try {
      const tries = [
        { pdfsettings: "/ebook", colorRes: 144, grayRes: 144, monoRes: 144 },
        { pdfsettings: "/screen", colorRes: 120, grayRes: 120, monoRes: 120 },
        { pdfsettings: "/screen", colorRes: 96,  grayRes: 96,  monoRes: 96  }
      ];

      for (const t of tries) {
        await runGhostscript(inPath, outPath, t);
        const size = fs.existsSync(outPath) ? fs.statSync(outPath).size : Infinity;
        if (size <= targetKb * 1024) break;
        fs.copyFileSync(outPath, inPath);
      }

      if (!fs.existsSync(outPath)) throw new Error("No output file");
      streamFile(res, outPath, "compressed.pdf", "application/pdf");
    } catch (e) {
      console.error("pdf compress error:", e);
      res.status(500).json({ error: "Failed to compress PDF" });
      safeUnlink(outPath);
    } finally {
      safeUnlink(inPath);
    }
  }));

  router.post("/api/convert/images-to-pdf", upload.array("files"), async (req, res) => {
    try {
      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: "Please upload at least one image." });
      }

      const pdfDoc = await PDFDocument.create();

      for (const f of req.files) {
        const bytes = fs.readFileSync(f.path);
        const name = (f.originalname || "").toLowerCase();
        let img;
        if ((f.mimetype || "").includes("jpeg") || name.endsWith(".jpg")) {
          img = await pdfDoc.embedJpg(bytes);
        } else if ((f.mimetype || "").includes("png") || name.endsWith(".png")) {
          img = await pdfDoc.embedPng(bytes);
        } else {
          try { img = await pdfDoc.embedJpg(bytes); } catch { img = await pdfDoc.embedPng(bytes); }
        }
        const dims = img.scale(1);

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

      const outFile = path.join(outDir, `images-${Date.now()}-${process.hrtime.bigint()}.pdf`);
      fs.writeFileSync(outFile, await pdfDoc.save());
      streamFile(res, outFile, "images.pdf", "application/pdf");
    } catch (e) {
      console.error("images->pdf error:", e);
      res.status(500).json({ error: "Failed to build PDF from images" });
    } finally {
      for (const f of req.files || []) safeUnlink(f.path);
    }
  });

  // Returns a zip with one PNG per page.
  router.post("/api/convert/pdf-to-images", upload.single("file"), heavy(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const pdfPath = req.file.path;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdfimgs-"));

    try {
      await runPdftoppm(pdfPath, path.join(tmpDir, "page"));

      const files = fs.readdirSync(tmpDir)
        .filter((f) => f.endsWith(".png"))
        .sort((a, b) => parseInt(a.split("-").pop(), 10) - parseInt(b.split("-").pop(), 10));

      if (files.length === 0) throw new Error("No images generated from PDF.");

      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", 'attachment; filename="pages.zip"');

      const archive = archiver("zip", { zlib: { level: 9 } });
      // Throwing inside this listener would crash the whole process; end the response instead.
      archive.on("error", (err) => { console.error("zip error:", err); res.destroy(err); });
      archive.pipe(res);

      for (const f of files) archive.file(path.join(tmpDir, f), { name: f });
      await archive.finalize();
    } catch (e) {
      console.error("pdf->images error:", e);
      if (!res.headersSent) res.status(500).json({ error: "Failed to convert PDF to images" });
    } finally {
      safeUnlink(pdfPath);
      safeRmDir(tmpDir);
    }
  }));

  return router;
}

module.exports = { pdfRouter };
