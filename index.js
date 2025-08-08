const express = require("express");
const multer = require("multer");
const cors = require("cors");
const { PDFDocument } = require("pdf-lib");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const CloudConvert = require("cloudconvert");
const cloudConvert = new CloudConvert(process.env.CLOUDCONVERT_API_KEY);
const app = express();
require('dotenv').config();

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

async function runCloudConvert(filePath, outputFormat, inputFormat) {
    // 1) Create job with tasks
    const job = await cloudConvert.jobs.create({
      tasks: {
        "import-1": { operation: "import/upload" },
        "convert-1": {
          operation: "convert",
          input: "import-1",
          output_format: outputFormat, // "docx" or "pdf"
          // optional tune for better doc fidelity:
          // e.g. for pdf->docx, engine: "office"
        },
        "export-1": { operation: "export/url", input: "convert-1" }
      }
    });

    const uploadTask = job.tasks.find(t => t.name === "import-1");
    // 2) Upload local file to CloudConvert
    await cloudConvert.tasks.upload(uploadTask, fs.createReadStream(filePath));

    // 3) Wait for conversion to finish
    const finished = await cloudConvert.jobs.wait(job.id);
    const exportTask = finished.tasks.find(t => t.name === "export-1" && t.status === "finished");
    if (!exportTask || !exportTask.result || !exportTask.result.files || !exportTask.result.files.length) {
      throw new Error("Export task failed");
    }

    // 4) Get file URL
    const fileUrl = exportTask.result.files[0].url;

    // 5) Download bytes
    const resp = await axios.get(fileUrl, { responseType: "arraybuffer" });
    return Buffer.from(resp.data);
  }

  // ---------- PDF -> DOCX ----------
  app.post("/api/convert/pdf-to-docx", upload.single("file"), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });
      const filePath = req.file.path;

      // optional: validate mime
      // if (req.file.mimetype !== "application/pdf") ...

      const outBytes = await runCloudConvert(filePath, "docx", "pdf");

      // cleanup
      fs.unlink(req.file.path, () => {});

      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
      res.setHeader("Content-Disposition", 'attachment; filename="converted.docx"');
      res.send(outBytes);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Conversion failed" });
    }
  });

  // ---------- DOCX -> PDF ----------
  app.post("/api/convert/docx-to-pdf", upload.single("file"), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });
      const filePath = req.file.path;

      // optional: validate .docx
      // if (!req.file.originalname.toLowerCase().endsWith(".docx")) ...

      const outBytes = await runCloudConvert(filePath, "pdf", "docx");

      // cleanup
      fs.unlink(req.file.path, () => {});

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", 'attachment; filename="converted.pdf"');
      res.send(outBytes);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Conversion failed" });
    }
  });

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Backend running on :${PORT}`));
