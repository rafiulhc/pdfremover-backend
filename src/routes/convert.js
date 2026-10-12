// Office conversions through LibreOffice. Each job converts into its own temp dir:
// findConverted() matches by name, so a shared dir could hand one user another user's file.
const express = require("express");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { safeUnlink, safeRmDir, findConverted } = require("../lib/files");
const { runSoffice, sofficeConvertArgs } = require("../lib/converters");

const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

async function convertWithSoffice(file, ext, jobDir, { filter, infilter } = {}) {
  const baseNoExt = path.parse(file.originalname || "input").name;
  const format = filter ? `${ext}:${filter}` : ext;
  await runSoffice(sofficeConvertArgs(format, jobDir, file.path, { infilter }));
  const outFile =
    findConverted(jobDir, baseNoExt, ext) ||
    findConverted(jobDir, path.parse(file.path).name, ext);
  if (!outFile || !fs.existsSync(outFile)) throw new Error("Conversion output not found");
  return outFile;
}

function convertRouter({ upload, heavy }) {
  const router = express.Router();

  router.post("/api/convert/docx-to-pdf", upload.single("file"), heavy(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), "lo-"));
    try {
      const outFile = await convertWithSoffice(req.file, "pdf", jobDir);
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
      safeUnlink(req.file.path);
      safeRmDir(jobDir);
    }
  }));

  router.post("/api/convert/pdf-to-docx", upload.single("file"), heavy(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), "lo-"));
    try {
      const outFile = await convertWithSoffice(req.file, "docx", jobDir, {
        infilter: "writer_pdf_import", filter: "MS Word 2007 XML",
      });
      // Read before the finally block removes jobDir.
      const out = fs.readFileSync(outFile);
      res.setHeader("Content-Type", DOCX_TYPE);
      res.setHeader("Content-Disposition", 'attachment; filename="converted.docx"');
      res.send(out);
    } catch (e) {
      console.error("pdf->docx error:", e.message);
      res.status(500).json({ error: "Conversion failed: " + e.message });
    } finally {
      safeUnlink(req.file.path);
      safeRmDir(jobDir);
    }
  }));

  return router;
}

module.exports = { convertRouter };
