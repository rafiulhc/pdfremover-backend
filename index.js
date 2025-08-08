const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { PDFDocument } = require("pdf-lib");

const app = express();

// CORS: add your Vercel URL (and localhost for dev)
const corsOptions = {
  origin: [
    "http://localhost:3000",
    "https://pdfremover-frontend.vercel.app"
  ],
  methods: ["POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"]
};
app.use(cors(corsOptions));


// Multer in-memory (no temp files on disk)
const upload = multer({ storage: multer.memoryStorage() });

// Health check
app.get("/", (_req, res) => res.status(200).send("OK"));

app.post("/api/remove-pages", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const buffer = req.file.buffer;

    // pagesToRemove: "1,3,5"
    const pagesToRemove = (req.body.pagesToRemove || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((n) => parseInt(n, 10) - 1) // zero-based
      .filter((n) => Number.isInteger(n));

    const srcPdf = await PDFDocument.load(buffer);
    const total = srcPdf.getPageCount();

    // basic validation
    const uniqueRemovals = [...new Set(pagesToRemove)].filter(
      (i) => i >= 0 && i < total
    );
    if (uniqueRemovals.length === total) {
      return res.status(400).json({ error: "Cannot remove all pages" });
    }

    const keepIndices = [];
    for (let i = 0; i < total; i++) {
      if (!uniqueRemovals.includes(i)) keepIndices.push(i);
    }

    const outPdf = await PDFDocument.create();
    const copied = await outPdf.copyPages(srcPdf, keepIndices);
    copied.forEach((p) => outPdf.addPage(p));
    const outBytes = await outPdf.save();

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="cleaned.pdf"');
    res.send(Buffer.from(outBytes));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Processing failed" });
  }
});

// Add this in your existing backend file (e.g., server.js)

const mergeUpload = multer({ dest: "uploads/" }).array("files", 10); // allow up to 10 PDFs

app.post("/api/merge-pdfs", mergeUpload, async (req, res) => {
  try {
    const outPdf = await PDFDocument.create();

    for (const file of req.files) {
      const buffer = fs.readFileSync(file.path);
      const srcPdf = await PDFDocument.load(buffer);

      const copiedPages = await outPdf.copyPages(
        srcPdf,
        srcPdf.getPageIndices()
      );

      copiedPages.forEach(p => outPdf.addPage(p));
      fs.unlinkSync(file.path); // cleanup temp file
    }

    const outBytes = await outPdf.save();

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="merged.pdf"');
    res.send(Buffer.from(outBytes));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to merge PDFs." });
  }
});


const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Backend running on :${PORT}`));
