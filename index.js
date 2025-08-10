const express = require("express");
const multer = require("multer");
const cors = require("cors");
const { PDFDocument } = require("pdf-lib");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const sharp = require("sharp");
const app = express();
const archiver = require("archiver");
const { mkdtempSync, rmSync } = require("fs");
const os = require("os");
const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require("docx");
const { OpenAI } = require("openai");
const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

// ==== Resume tickets ====
const resumeTickets = new Map();
/*
resumeTickets.set(ticketId, {
  paid: false,
  createdAt: number,
  inputs: {...}    // user form data
});
*/

const GUMROAD_RESUME_PERMALINK = process.env.GUMROAD_PRODUCT_PERMALINK_RESUME || "nktxk";


// ==== CloudConvert + helpers ====
const CloudConvert = require("cloudconvert");
const axios = require("axios");
const { randomUUID } = require("crypto");

const cloudConvert = new CloudConvert(process.env.CLOUDCONVERT_API_KEY || "");
const GUMROAD_PRODUCT_PERMALINK = process.env.GUMROAD_PRODUCT_PERMALINK || "ubtedo";
const GUMROAD_MIN_PRICE_CENTS = parseInt(process.env.GUMROAD_MIN_PRICE_CENTS || "199", 10);
const GUMROAD_ACCESS_TOKEN = process.env.GUMROAD_ACCESS_TOKEN || "";

// tickets: memory map (single dyno). Use Redis if you scale multiple dynos.
const tickets = new Map();
/*
tickets.set(ticketId, {
  jobId, paid:false, ready:false, file:{url, filename}|null, createdAt:number, error:string|null
});
*/
// 🧹 Clean up old tickets every 30 minutes
setInterval(() => {
  const now = Date.now();
  for (const [t, rec] of tickets) {
    if (now - rec.createdAt > 2 * 60 * 60 * 1000) {
      tickets.delete(t); // remove tickets older than 2 hours
    }
  }
}, 30 * 60 * 1000); // every 30 minutes
// ---------- basics ----------
app.use(cors({
  origin: [
    "http://localhost:3000",
    "https://pdfremover-frontend.vercel.app",
    "https://pdfmergersplitter.app",
    "https://www.pdfmergersplitter.app"
  ],
  methods: ["POST", "GET", "OPTIONS"],
  allowedHeaders: ["Content-Type"]
}));

function buildResumeHTML({ fullName, email, phone, location, role, summary, skills = [], experience = [], education = [] }) {
  const esc = (s="") => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const list = (arr=[]) => arr.map(x => `<li>${esc(x)}</li>`).join("");

  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width">
<title>Resume Preview</title>
<style>
  body{margin:0;background:#eef2f7;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif}
  .page{width:800px;aspect-ratio:1 / 1.4142;background:#fff;margin:24px auto;padding:48px;
        box-shadow:0 20px 60px rgba(0,0,0,.15);box-sizing:border-box}
  h1{margin:0 0 4px 0;font-size:28px}
  .sub{color:#334155;margin:2px 0 12px 0}
  h2{font-size:16px;margin:18px 0 8px 0;border-bottom:1px solid #e5e7eb;padding-bottom:6px}
  ul{margin:0;padding-left:18px}
  li{margin:6px 0;line-height:1.45}
  .row{display:flex;gap:8px;flex-wrap:wrap;color:#334155}
  .job{margin:8px 0}
  .job h3{margin:0 0 2px 0;font-size:15px}
  .dates{color:#64748b;font-size:12px;margin-bottom:4px}
  @media (max-width:860px){.page{width:min(92vw,800px);padding:clamp(20px,4vw,48px)}}
</style>
<body>
  <div class="page">
    <h1>${esc(fullName || "")}</h1>
    <div class="sub">${[email, phone, location].filter(Boolean).map(esc).join(" • ")}</div>
    ${role ? `<div class="sub"><strong>${esc(role)}</strong></div>` : ""}

    ${summary ? `<h2>Summary</h2><p>${esc(summary)}</p>` : ""}

    ${skills.length ? `<h2>Skills</h2><div class="row">${skills.map(s=>`<span>${esc(s)}</span>`).join(" • ")}</div>` : ""}

    ${experience.length ? `<h2>Experience</h2>
      ${experience.map(j => `
        <div class="job">
          <h3>${esc([j.title, j.company].filter(Boolean).join(" — "))}</h3>
          <div class="dates">${esc([j.start, j.end].filter(Boolean).join(" – "))}</div>
          ${j.bullets?.length ? `<ul>${list(j.bullets)}</ul>` : ""}
        </div>
      `).join("")}
    ` : ""}

    ${education.length ? `<h2>Education</h2>
      ${education.map(ed => `
        <div class="job">
          <h3>${esc([ed.degree, ed.school].filter(Boolean).join(" — "))}</h3>
          <div class="dates">${esc([ed.start, ed.end].filter(Boolean).join(" – "))}</div>
        </div>
      `).join("")}
    ` : ""}
  </div>
</body></html>`;
}


function buildATSResumeDocx(data) {
  const {
    fullName = "",
    email = "",
    phone = "",
    location = "",
    role = "",
    summary = "",
    skills = [],
    experience = [], // [{company, title, start, end, bullets:[]}]
    education = [],  // [{school, degree, start, end}]
  } = data;

  const doc = new Document({
    sections: [{
      properties: {},
      children: [
        new Paragraph({ text: fullName, heading: HeadingLevel.TITLE }),
        new Paragraph({ text: [email, phone, location].filter(Boolean).join(" | ") }),
        role ? new Paragraph({ text: role, spacing: { after: 160 } }) : new Paragraph({ text: "" }),

        ...(summary ? [
          new Paragraph({ text: "Summary", heading: HeadingLevel.HEADING_1 }),
          new Paragraph({ text: summary, spacing: { after: 160 } }),
        ] : []),

        ...(skills?.length ? [
          new Paragraph({ text: "Skills", heading: HeadingLevel.HEADING_1 }),
          new Paragraph({ text: skills.join(", "), spacing: { after: 160 } }),
        ] : []),

        ...(experience?.length ? [
          new Paragraph({ text: "Experience", heading: HeadingLevel.HEADING_1 }),
          ...experience.flatMap((job) => {
            const lines = [];
            const header = [job.title, job.company].filter(Boolean).join(" — ");
            const dates = [job.start, job.end].filter(Boolean).join(" – ");
            lines.push(new Paragraph({ text: header, heading: HeadingLevel.HEADING_2 }));
            if (dates) lines.push(new Paragraph({ text: dates }));
            (job.bullets || []).forEach(b => {
              lines.push(new Paragraph({
                children: [new TextRun({ text: "• " + b })],
              }));
            });
            lines.push(new Paragraph({ text: "", spacing: { after: 120 } }));
            return lines;
          }),
        ] : []),

        ...(education?.length ? [
          new Paragraph({ text: "Education", heading: HeadingLevel.HEADING_1 }),
          ...education.flatMap((ed) => {
            const header = [ed.degree, ed.school].filter(Boolean).join(" — ");
            const dates = [ed.start, ed.end].filter(Boolean).join(" – ");
            return [
              new Paragraph({ text: header, heading: HeadingLevel.HEADING_2 }),
              dates ? new Paragraph({ text: dates }) : new Paragraph({ text: "" }),
              new Paragraph({ text: "", spacing: { after: 120 } }),
            ];
          }),
        ] : []),
      ],
    }],
  });

  return Packer.toBuffer(doc);
}

async function reconcileGumroadPaymentForResume(ticket) {
  try {
    if (!process.env.GUMROAD_ACCESS_TOKEN) return false;
    const token = process.env.GUMROAD_ACCESS_TOKEN;
    const permalink = GUMROAD_RESUME_PERMALINK;
    const since = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const url = `https://api.gumroad.com/v2/sales?access_token=${encodeURIComponent(token)}&product_permalink=${encodeURIComponent(permalink)}&after=${encodeURIComponent(since)}`;
    const { data } = await axios.get(url);
    const sales = data?.sales || [];
    for (const s of sales) {
      const params = s.url_params || {};
      const saleTicket = params.ticket || params.TICKET;
      const refunded = String(s.refunded || "").toLowerCase() === "true";
      if (!refunded && saleTicket === ticket) return true;
    }
  } catch (e) {
    console.warn("reconcileGumroadPaymentForResume error:", e.message);
  }
  return false;
}


function previewPrompt(inputs) {
  const { role = "", skills = "", experienceText = "" } = inputs;
  return `You are a professional resume writer. Create a SHORT preview (5-7 bullet points) of an ATS-friendly resume for the following candidate.

Role target: ${role}
Key skills: ${skills}
Experience summary (raw text): ${experienceText}

Rules:
- Output plain text bullets only.
- No tables, no fancy formatting.
- Focus on quantified, impact-oriented bullets.
- Keep to 5-7 lines.`;
}

function fullJsonPrompt(inputs) {
  const { fullName="", email="", phone="", location="", role="", yearsExp="", skills="", achievements="", experienceText="", educationText="" } = inputs;
  return `You are an expert resume writer. Produce a clean JSON (and ONLY JSON) for an ATS-friendly resume.

Candidate:
- Name: ${fullName}
- Email: ${email}
- Phone: ${phone}
- Location: ${location}
- Target role: ${role}
- Years experience: ${yearsExp}
- Key skills (comma-separated): ${skills}
- Achievements (raw text): ${achievements}
- Experience (raw text): ${experienceText}
- Education (raw text): ${educationText}

Return strictly this JSON schema:
{
  "summary": "1 short paragraph",
  "skills": ["Skill A", "Skill B", "..."],
  "experience": [
    { "company": "", "title": "", "start": "", "end": "", "bullets": ["...", "..."] }
  ],
  "education": [
    { "school": "", "degree": "", "start": "", "end": "" }
  ]
}

Rules:
- Keep it factual and ATS-friendly. No tables.
- Convert raw text into clean bullets with strong action verbs and numbers where implied.
- If dates are unknown, leave empty strings.
- Only output JSON.`;
}

app.post("/api/ai/resume/preview", express.json(), async (req, res) => {
  try {
    if (!openai) return res.status(500).json({ error: "AI not configured" });
    const inputs = req.body || {};
    const prompt = previewPrompt(inputs);
    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
      max_tokens: 250,
    });
    const text = resp.choices?.[0]?.message?.content?.trim() || "";
    return res.json({ preview: text });
  } catch (e) {
    console.error("resume preview error:", e);
    return res.status(500).json({ error: "Failed to build preview" });
  }
});


app.post("/api/ai/resume/prepare", express.json(), async (req, res) => {
  try {
    const inputs = req.body || {};
    const ticket = (randomUUID ? randomUUID() : String(Date.now()+Math.random())).replace(/-/g,"");
    resumeTickets.set(ticket, {
      paid: false,
      createdAt: Date.now(),
      inputs,                 // includes previewJson if provided
    });
    const buyUrl = `https://gumroad.com/l/${encodeURIComponent(GUMROAD_RESUME_PERMALINK || GUMROAD_PRODUCT_PERMALINK)}?wanted=true&ticket=${encodeURIComponent(ticket)}&fields[ticket]=${encodeURIComponent(ticket)}`;
    console.log("RESUME PREPARE", { ticket, buyUrl });
    return res.json({ ticket, buyUrl });
  } catch (e) {
    console.error("resume prepare error:", e);
    return res.status(500).json({ error: "Failed to init resume purchase" });
  }
});



app.get("/api/ai/resume/status", async (req, res) => {
  const ticket = String(req.query.ticket || "");
  const rec = resumeTickets.get(ticket);
  if (!rec) return res.status(404).json({ error: "Invalid ticket" });

  // no-cache
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  res.set("Surrogate-Control", "no-store");

  // Try reconciling if still unpaid
  if (!rec.paid) {
    try {
      const paidNow = await reconcileGumroadPaymentForResume(ticket);
      if (paidNow) {
        rec.paid = true;
        console.log("RESUME STATUS: payment reconciled from Gumroad API", { ticket });
      }
    } catch {}
  }

  res.json({ paid: rec.paid });
});

app.get("/api/ai/resume/download", async (req, res) => {
  try {
    const ticket = String(req.query.ticket || "");
    const rec = resumeTickets.get(ticket);
    if (!rec) return res.status(404).json({ error: "Invalid ticket" });
    if (!rec.paid) return res.status(402).json({ error: "Payment required" });
    if (!openai) return res.status(500).json({ error: "AI not configured" });

    // If we already have preview JSON, reuse it (no regeneration)
    let json = rec?.inputs?.previewJson;
    if (!json) {
      // fallback (should be rare)
      const prompt = fullJsonPrompt(rec.inputs || {});
      const resp = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
        max_tokens: 900,
        response_format: { type: "json_object" }
      });
      json = JSON.parse(resp.choices?.[0]?.message?.content || "{}");
    }

    const buf = await buildATSResumeDocx({
      fullName: rec.inputs.fullName,
      email: rec.inputs.email,
      phone: rec.inputs.phone,
      location: rec.inputs.location,
      role: rec.inputs.role,
      summary: json.summary || "",
      skills: Array.isArray(json.skills) ? json.skills : [],
      experience: Array.isArray(json.experience) ? json.experience : [],
      education: Array.isArray(json.education) ? json.education : [],
    });

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", `attachment; filename="resume.docx"`);
    return res.send(buf);
  } catch (e) {
    console.error("resume download error:", e);
    return res.status(500).json({ error: "Failed to generate resume" });
  }
});




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

// ---------- routes (existing free tools) ----------

/** Remove pages */
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

/** PDF -> DOCX (LibreOffice baseline, free) */
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

// ---------- debug route ----------
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
      if (format === "webp" || "jpeg") {
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

// ===================== PRO (CloudConvert + Gumroad) =====================

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

    // async waiter for CC
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


    // const buyUrl =
    //   `https://gumroad.com/l/${encodeURIComponent(GUMROAD_PRODUCT_PERMALINK)}?wanted=true&fields[ticket]=${encodeURIComponent(ticket)}`;

    console.log("PRO PREPARE RESP:", { ticket, buyUrl });
    return res.json({ ticket, buyUrl });
  } catch (e) {
    console.error("pro/prepare error:", e);
    try { fs.unlinkSync(req.file.path); } catch {}
    return res.status(500).json({ error: "Failed to initialize conversion" });
  }
});

// Gumroad reconciliation (in case webhook missed)
async function reconcileGumroadPayment(ticket) {
  try {
    if (!process.env.GUMROAD_ACCESS_TOKEN) return false;
    const token = process.env.GUMROAD_ACCESS_TOKEN;
    const permalink = process.env.GUMROAD_PRODUCT_PERMALINK;

    // Look back 2 hours for the sale containing our ?ticket=...
    const since = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const url = `https://api.gumroad.com/v2/sales?access_token=${encodeURIComponent(token)}&product_permalink=${encodeURIComponent(permalink)}&after=${encodeURIComponent(since)}`;

    const { data } = await axios.get(url);
    const sales = data?.sales || [];
    for (const s of sales) {
      const params = s.url_params || {};
      const saleTicket = params.ticket || params.TICKET;
      const refunded = String(s.refunded || "").toLowerCase() === "true";
      if (!refunded && saleTicket === ticket) return true;
    }
  } catch (e) {
    console.warn("reconcileGumroadPayment error:", e.message);
  }
  return false;
}


// Poll status (self-heal CC ready + payment reconciliation)
app.get("/api/pro/status", async (req, res) => {
  const ticket = String(req.query.ticket || "");
  const rec = tickets.get(ticket);
  if (!rec) return res.status(404).json({ error: "Invalid ticket" });

  // Never cache status
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  res.set("Surrogate-Control", "no-store");

  // Self-heal CloudConvert readiness
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

  // Self-heal payment via Gumroad API (if ping missed)
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

app.use("/api/gumroad/ping", express.urlencoded({ extended: true }));

app.post("/api/gumroad/ping", (req, res) => {
  try {
    const { product_permalink, price, refunded, url_params, custom_fields } = req.body;
    const slug = (product_permalink || "").split("/").pop();

    // Accept PPP: any positive amount
    const cents = parseInt(price || "0", 10);
    if (!Number.isFinite(cents) || cents < 1) {
      console.log("PING: no/zero price", { cents });
      return res.status(400).send("No payment amount");
    }

    if (String(refunded || "").toLowerCase() === "true") {
      console.log("PING: refunded");
      return res.status(200).send("Ignored (refunded)");
    }

    // Extract ticket from all places Gumroad might send it
    let ticket;
    if (!ticket && url_params) {
      if (typeof url_params === "string") {
        try { ticket = JSON.parse(url_params).ticket; } catch {}
      } else if (typeof url_params === "object") {
        ticket = url_params.ticket || url_params.TICKET;
      }
    }
    if (!ticket && custom_fields && typeof custom_fields === "object") {
      ticket = custom_fields.ticket || custom_fields.TICKET;
    }
    if (!ticket && typeof req.body["fields[ticket]"] === "string") {
      ticket = req.body["fields[ticket]"];
    }
    if (!ticket && typeof req.body.ticket === "string") {
      ticket = req.body.ticket;
    }

    // Debug: what do we have when this ping arrives?
    console.log("PING incoming", {
      product: slug,
      ticket,
      ticketsSize: tickets.size,
      resumeTicketsSize: resumeTickets.size
    });

    if (!ticket) {
      console.log("PING: missing ticket entirely");
      return res.status(200).send("No matching ticket");
    }

    // Try resume first, then pro
    let rec = resumeTickets.get(ticket);
    if (rec) {
      rec.paid = true;
      console.log("PING: OK (paid) RESUME", { ticket, cents, product: slug });
      return res.status(200).send("OK");
    }

    rec = tickets.get(ticket);
    if (rec) {
      rec.paid = true;
      console.log("PING: OK (paid) PDFPRO", { ticket, cents, product: slug });
      return res.status(200).send("OK");
    }

    console.log("PING: no matching ticket", { ticket, product: slug });
    return res.status(200).send("No matching ticket");
  } catch (e) {
    console.error("gumroad/ping error:", e);
    return res.status(500).send("Ping handler error");
  }
});

app.post("/api/ai/resume/preview", express.json(), async (req, res) => {
  try {
    if (!openai) return res.status(500).json({ error: "AI not configured" });
    const inputs = req.body || {};
    // build full JSON once here (same as download)
    const prompt = fullJsonPrompt(inputs);
    const resp = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      max_tokens: 900,
      response_format: { type: "json_object" }
    });

    let json = {};
    try { json = JSON.parse(resp.choices?.[0]?.message?.content || "{}"); }
    catch { /* best-effort salvage */ }

    // fallback skills if model returns none
    if (!Array.isArray(json.skills)) {
      json.skills = String(inputs.skills || "")
        .split(",").map(s=>s.trim()).filter(Boolean);
    }

    const html = buildResumeHTML({
      fullName: inputs.fullName,
      email: inputs.email,
      phone: inputs.phone,
      location: inputs.location,
      role: inputs.role,
      summary: json.summary || "",
      skills: json.skills || [],
      experience: Array.isArray(json.experience) ? json.experience : [],
      education: Array.isArray(json.education) ? json.education : [],
    });

    return res.json({ json, html });
  } catch (e) {
    console.error("resume preview error:", e);
    return res.status(500).json({ error: "Failed to build preview" });
  }
});



// ---------- start ----------
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Backend running on :${PORT}`));
