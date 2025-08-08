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

// Util: find task by name
function byName(tasks, name) {
    return tasks.find((t) => t.name === name);
  }

  // Util: throw with CloudConvert task error details
  function assertFinished(task, label) {
    if (!task) throw new Error(`${label} task missing`);
    if (task.status !== "finished") {
      const msg = task?.message || task?.error || JSON.stringify(task, null, 2);
      throw new Error(`${label} task not finished: ${msg}`);
    }
  }

  async function runCloudConvert({ filePath, inputFormat, outputFormat, useOffice = true }) {
    // 1) Create a job with import -> convert -> export
    const job = await cloudConvert.jobs.create({
      tasks: {
        "import-1": { operation: "import/upload" },
        "convert-1": {
          operation: "convert",
          input: "import-1",
          input_format: inputFormat,     // e.g. "pdf" or "docx"
          output_format: outputFormat,   // e.g. "docx" or "pdf"
          ...(useOffice ? { engine: "office" } : {}), // **important for fidelity**
        },
        "export-1": { operation: "export/url", input: "convert-1" },
      },
    });

    // 2) Upload your local file to import-1
    const importTask = byName(job.tasks, "import-1");
    await cloudConvert.tasks.upload(importTask, fs.createReadStream(filePath), {
      filename: filePath.split("/").pop(),
    });

    // 3) Wait for job to complete
    const finishedJob = await cloudConvert.jobs.wait(job.id);

    // 4) Inspect tasks for better errors
    const importDone = byName(finishedJob.tasks, "import-1");
    const convertDone = byName(finishedJob.tasks, "convert-1");
    const exportDone  = byName(finishedJob.tasks, "export-1");

    // If convert task errored, surface its message
    if (convertDone?.status === "error") {
      const msg = convertDone?.message || convertDone?.error || "Unknown convert error";
      throw new Error(`Convert failed: ${msg}`);
    }

    // Guard all finished statuses
    assertFinished(importDone, "Import");
    assertFinished(convertDone, "Convert");
    assertFinished(exportDone, "Export");

    if (!exportDone.result?.files?.length) {
      throw new Error("Export produced no files");
    }

    // 5) Download final file
    const fileUrl = exportDone.result.files[0].url;
    const resp = await axios.get(fileUrl, { responseType: "arraybuffer" });
    return Buffer.from(resp.data);
  }



  // PDF -> DOCX
  app.post("/api/convert/pdf-to-docx", upload.single("file"), async (req, res) => {
    const tmp = req.file?.path;
    if (!tmp) return res.status(400).json({ error: "No file uploaded" });

    try {
      const out = await runCloudConvert({
        filePath: tmp,
        inputFormat: "pdf",
        outputFormat: "docx",
        useOffice: true,
      });

      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      );
      res.setHeader("Content-Disposition", 'attachment; filename="converted.docx"');
      res.send(out);
    } catch (e) {
      console.error("pdf-to-docx error:", e?.message || e);
      // Bubble a helpful message to the client
      res.status(500).json({ error: e?.message || "Conversion failed" });
    } finally {
      fs.unlink(tmp, () => {});
    }
  });

  // DOCX -> PDF
  app.post("/api/convert/docx-to-pdf", upload.single("file"), async (req, res) => {
    const tmp = req.file?.path;
    if (!tmp) return res.status(400).json({ error: "No file uploaded" });

    try {
      const out = await runCloudConvert({
        filePath: tmp,
        inputFormat: "docx",
        outputFormat: "pdf",
        useOffice: true,
      });

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", 'attachment; filename="converted.pdf"');
      res.send(out);
    } catch (e) {
      console.error("docx-to-pdf error:", e?.message || e);
      res.status(500).json({ error: e?.message || "Conversion failed" });
    } finally {
      fs.unlink(tmp, () => {});
    }
  });

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Backend running on :${PORT}`));
