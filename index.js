/**
 * Blazing-fast, production-ready backend (drop-in)
 * - Keeps all routes and response shapes the same as your current server
 * - Streams large files, uses /tmp job dirs, adds backpressure, prewarms LO, tunes GS/Sharp
 */

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
const { Document, Packer, Paragraph, TextRun } = require("docx");
const { OpenAI } = require("openai");
const CloudConvert = require("cloudconvert");
const axios = require("axios");
const { randomUUID } = require("crypto");
const puppeteer = require("puppeteer-core");

// ===== env / service clients =====
const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
const cloudConvert = new CloudConvert(process.env.CLOUDCONVERT_API_KEY || "");

// ===== settings (good defaults for Heroku Basic dyno) =====
const HEAVY_CONCURRENCY = parseInt(process.env.HEAVY_CONCURRENCY || "2", 10); // pdf->docx, docx->pdf, pdf compress, pdf->images
const WEB_CONCURRENCY = parseInt(process.env.WEB_CONCURRENCY || "2", 10);     // set in container env; shown here for clarity

// ===== minimal p-limit (no extra dependency) =====
function createLimit(concurrency) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= concurrency) return;
    const job = queue.shift();
    if (!job) return;
    active++;
    Promise.resolve()
      .then(job.fn)
      .then((v) => { active--; job.resolve(v); next(); })
      .catch((e) => { active--; job.reject(e); next(); });
  };
  return (fn) => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject }); next();
  });
}
const heavyLimit = createLimit(HEAVY_CONCURRENCY);
const limitHeavy = (handler) => (req, res) =>
  heavyLimit(() => handler(req, res)).catch((err) => {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: "Processing failed" });
  });

// ===== fast temp storage =====
const BASE_TMP = os.tmpdir(); // ephemeral, fast on Heroku containers
const OUTDIR = fs.mkdtempSync(path.join(BASE_TMP, "pdfapp-"));
const upload = multer({
  dest: OUTDIR,
  limits: { fileSize: 32 * 1024 * 1024, files: 20 },
});

// ===== utils: streaming downloads & cleanup =====
function streamFile(res, absPath, filename, contentType) {
  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  const rs = fs.createReadStream(absPath);
  rs.pipe(res);

  const cleanup = () => { try { fs.unlinkSync(absPath); } catch {} };
  rs.on("error", (e) => {
    console.error("stream error:", e);
    if (!res.headersSent) res.status(500).end();
    cleanup();
  });
  rs.on("close", cleanup);
  res.on("close", cleanup);
}

// ====== tiny helpers you already had (kept) ======
function buildResumeHTML({
  fullName, email, phone, location, role,
  summary, skills = [], experience = [], education = [],
  links = [], areaOfExpertise = []
}) {
  const esc = (s="") => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const list = (arr=[]) => arr.map(x => `<li>${esc(x)}</li>`).join("");
  const pill = (arr=[]) => arr.map(x => `<span class="pill">${esc(x)}</span>`).join("");
  const linkRow = (arr=[]) => arr
    .filter(l => l && l.url)
    .map(l => `<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label || new URL(l.url).hostname.replace(/^www\./,''))}</a>`)
    .join(" • ");

  return `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Resume Preview</title>
<style>
  :root{--ink:#0f172a;--muted:#475569;--line:#e2e8f0;--brand:#1d4ed8;--bg:#ffffff;--pill-bg:#eef2ff;--pill-text:#1e293b}
  html,body{margin:0;background:#f5f7fb}
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:var(--ink)}
  .page{width:800px;margin:24px auto;background:var(--bg);padding:48px;box-shadow:0 24px 64px rgba(2,6,23,.12);border-radius:14px}
  h1{margin:0 0 4px;font-size:30px;letter-spacing:.2px}
  .sub{color:var(--muted);margin:2px 0 6px}
  .links a{color:var(--brand);text-decoration:none}.links a:hover{text-decoration:underline}
  h2{font-size:15px;text-transform:uppercase;letter-spacing:.12em;color:#0b1220;margin:18px 0 8px}
  .rule{height:1px;background:var(--line);margin:10px 0 14px}
  .pillRow{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0 2px}
  .pill{background:var(--pill-bg);border:1px solid #dbeafe;color:var(--pill-text);padding:6px 10px;border-radius:999px;font-size:12px}
  .job{margin:10px 0} .job h3{margin:0 0 2px;font-size:15px}
  .dates{color:var(--muted);font-size:12px;margin:2px 0 6px}
  ul{margin:0;padding-left:18px} li{margin:6px 0;line-height:1.45}
  .role{font-weight:700;color:#0b1220;margin-bottom:8px}
  @media (max-width:860px){.page{width:min(92vw,800px);padding:clamp(20px,4vw,48px)}}
</style>
<body><div class="page">
  <h1>${esc(fullName || "")}</h1>
  <div class="sub">${[email, phone, location].filter(Boolean).map(esc).join(" • ")}</div>
  ${links?.length ? `<div class="sub links">${linkRow(links)}</div>` : ""}
  ${role ? `<div class="role">${esc(role)}</div>` : ""}
  <div class="rule"></div>
  ${summary ? `<h2>Summary</h2><p>${esc(summary)}</p>` : ""}
  ${areaOfExpertise.length ? `<h2>Area of Expertise</h2><div class="pillRow">${pill(areaOfExpertise)}</div>` : ""}
  ${skills.length ? `<h2>Skills</h2><div class="pillRow">${pill(skills)}</div>` : ""}
  ${experience.length ? `<h2>Experience</h2>${experience.map(j => `
    <div class="job">
      <h3>${esc([j.title, j.company].filter(Boolean).join(" — "))}</h3>
      <div class="dates">${esc([j.start, j.end].filter(Boolean).join(" – "))}</div>
      ${j.bullets?.length ? `<ul>${list(j.bullets)}</ul>` : ""}
    </div>`).join("")}` : ""}
  ${education.length ? `<h2>Education</h2>${education.map(ed => `
    <div class="job">
      <h3>${esc([ed.degree, ed.school].filter(Boolean).join(" — "))}</h3>
      <div class="dates">${esc([ed.start, ed.end].filter(Boolean).join(" – "))}</div>
    </div>`).join("")}` : ""}
</div></body></html>`;
}

function buildATSResumeDocxCompact(data) {
  const {
    fullName = "", email = "", phone = "", location = "", role = "",
    summary = "", skills = [], experience = [], education = [], links = [], areaOfExpertise = []
  } = data || {};

  const INK = "0F172A", META = "475569", BRAND = "1D4ED8";
  const text = (s) => new TextRun(String(s || ""));
  const para = (txt, style="Body") => new Paragraph({ text: String(txt || ""), style });
  const bullet = (txt) => new Paragraph({ style: "Bullet", bullet: { level: 0 }, children: [ text(txt) ] });

  const children = [];
  if (fullName) children.push(new Paragraph({ text: fullName.trim(), style: "Name" }));
  const metaLine = [email, phone, location].filter(Boolean).join(" | ");
  if (metaLine) children.push(new Paragraph({ text: metaLine, style: "Meta" }));

  if (Array.isArray(links) && links.length) {
    const line = links.filter(l => l && (l.url || l.label))
      .map(l => `${l.label || ""}${l.label && l.url ? ": " : ""}${l.url || ""}`).join(" | ");
    if (line) children.push(new Paragraph({ text: line, style: "Meta" }));
  }
  if (role) children.push(new Paragraph({ text: role, style: "Role" }));

  if (summary) { children.push(para("Summary", "Section")); children.push(para(summary, "BodyTight")); }
  if (Array.isArray(areaOfExpertise) && areaOfExpertise.length) {
    children.push(para("Area of Expertise", "Section"));
    areaOfExpertise.forEach(i => children.push(bullet(i)));
  }
  if (Array.isArray(skills) && skills.length) {
    children.push(para("Skills", "Section"));
    children.push(para(skills.join(", "), "BodyTight"));
  }
  if (Array.isArray(experience) && experience.length) {
    children.push(para("Experience", "Section"));
    experience.forEach((job, idx) => {
      const head = [job.title, job.company].filter(Boolean).join(" — ");
      const dates = [job.start, job.end].filter(Boolean).join(" – ");
      if (head) children.push(para(head, "JobHeading"));
      if (dates) children.push(para(dates, "Meta"));
      if (Array.isArray(job.bullets)) job.bullets.forEach(b => children.push(bullet(b)));
      if (idx < experience.length - 1) children.push(new Paragraph({ text: "", style: "SpacerThin" }));
    });
  }
  if (Array.isArray(education) && education.length) {
    children.push(para("Education", "Section"));
    education.forEach((ed, idx) => {
      const head = [ed.degree, ed.school].filter(Boolean).join(" — ");
      const dates = [ed.start, ed.end].filter(Boolean).join(" – ");
      if (head) children.push(para(head, "JobHeading"));
      if (dates) children.push(para(dates, "Meta"));
      if (idx < education.length - 1) children.push(new Paragraph({ text: "", style: "SpacerThin" }));
    });
  }

  const doc = new Document({
    styles: {
      paragraphStyles: [
        { id: "Body", name: "Body", basedOn: "Normal",
          run: { font: "Calibri", size: 22, color: INK },
          paragraph: { spacing: { line: 276, after: 80 } } },
        { id: "BodyTight", name: "BodyTight", basedOn: "Body",
          run: { size: 22 }, paragraph: { spacing: { line: 276, after: 40 } } },
        { id: "Name", name: "Name", basedOn: "Body",
          run: { size: 36, bold: true, color: INK }, paragraph: { spacing: { after: 120 } } },
        { id: "Meta", name: "Meta", basedOn: "Body",
          run: { color: META, size: 20 }, paragraph: { spacing: { after: 60 } } },
        { id: "Role", name: "Role", basedOn: "Body",
          run: { size: 24, bold: true, color: INK }, paragraph: { spacing: { after: 120 } } },
        { id: "Section", name: "Section", basedOn: "Body",
          run: { bold: true, color: BRAND, size: 26 },
          paragraph: { spacing: { before: 200, after: 60 } } },
        { id: "JobHeading", name: "JobHeading", basedOn: "Body",
          run: { bold: true, color: INK, size: 24 }, paragraph: { spacing: { after: 20 } } },
        { id: "Bullet", name: "Bullet", basedOn: "Body",
          run: { size: 22, color: INK }, paragraph: { spacing: { line: 276, after: 40 } } },
        { id: "SpacerThin", name: "SpacerThin", basedOn: "Body",
          run: { size: 1, color: INK }, paragraph: { spacing: { after: 40 } } },
      ]
    },
    sections: [{ properties: { page: { margin: { top: 720, right: 720, bottom: 360, left: 720 } } }, children }]
  });
  return Packer.toBuffer(doc);
}

function buildATSResumeDocx(data) {
  const {
    fullName = "", email = "", phone = "", location = "", role = "",
    summary = "", skills = [], experience = [], education = [], links = [], areaOfExpertise = []
  } = data;

  const doc = new Document({
    styles: {
      paragraphStyles: [
        { id: "NormalPara", name: "NormalPara", basedOn: "Normal",
          run: { font: "Calibri", size: 22, color: "0F172A" }, paragraph: { spacing: { line: 276, after: 120 } } },
        { id: "TitleName", name: "TitleName",
          run: { font: "Calibri", size: 36, bold: true, color: "0B1220" }, paragraph: { spacing: { after: 200 } } },
        { id: "Meta", name: "Meta", run: { color: "475569", size: 20 }, paragraph: { spacing: { after: 80 } } },
        { id: "SectionHeading", name: "SectionHeading",
          run: { size: 24, bold: true, color: "1D4ED8" }, paragraph: { spacing: { before: 200, after: 100 } } },
        { id: "JobHeading", name: "JobHeading", run: { size: 22, bold: true, color: "0B1220" }, paragraph: { spacing: { after: 40 } } },
      ],
    },
    sections: [{
      properties: { page: { margin: { top: 720, right: 720, bottom: 720, left: 720 } } },
      children: [
        new Paragraph({ text: fullName, style: "TitleName" }),
        new Paragraph({ text: [email, phone, location].filter(Boolean).join(" | "), style: "Meta" }),
        links && links.length ? new Paragraph({ text: links.filter(l=>l&&l.url).map(l => `${l.label || ""}: ${l.url}`).join(" | "), style: "Meta" }) : new Paragraph({ text: "" }),
        role ? new Paragraph({ text: role, style: "NormalPara" }) : new Paragraph({ text: "" }),
        ...(summary ? [new Paragraph({ text: "Summary", style: "SectionHeading" }), new Paragraph({ text: summary, style: "NormalPara" })] : []),
        ...(areaOfExpertise?.length ? [new Paragraph({ text: "Area of Expertise", style: "SectionHeading" }), ...areaOfExpertise.map(s => new Paragraph({ style: "NormalPara", children: [new TextRun({ text: "• " + s })] }))] : []),
        ...(skills?.length ? [new Paragraph({ text: "Skills", style: "SectionHeading" }), ...skills.map(s => new Paragraph({ style: "NormalPara", children: [new TextRun({ text: "• " + s })] }))] : []),
        ...(experience?.length ? [new Paragraph({ text: "Experience", style: "SectionHeading" }),
          ...experience.flatMap(job => {
            const header = [job.title, job.company].filter(Boolean).join(" — ");
            const dates = [job.start, job.end].filter(Boolean).join(" – ");
            const lines = [];
            lines.push(new Paragraph({ text: header, style: "JobHeading" }));
            if (dates) lines.push(new Paragraph({ text: dates, style: "Meta" }));
            (job.bullets || []).forEach(b => lines.push(new Paragraph({ style: "NormalPara", children: [new TextRun({ text: "• " + b })] })));
            lines.push(new Paragraph({ text: "" }));
            return lines;
          }),
        ] : []),
        ...(education?.length ? [new Paragraph({ text: "Education", style: "SectionHeading" }),
          ...education.flatMap(ed => {
            const header = [ed.degree, ed.school].filter(Boolean).join(" — ");
            const dates = [ed.start, ed.end].filter(Boolean).join(" – ");
            const lines = [];
            lines.push(new Paragraph({ text: header, style: "JobHeading" }));
            if (dates) lines.push(new Paragraph({ text: dates, style: "Meta" }));
            lines.push(new Paragraph({ text: "" }));
            return lines;
          }),
        ] : []),
      ],
    }],
  });

  return Packer.toBuffer(doc);
}

// ==== Tickets (in-memory; unchanged) ====
const resumeTickets = new Map();
const tickets = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [t, rec] of tickets) if (now - rec.createdAt > 2 * 60 * 60 * 1000) tickets.delete(t);
}, 30 * 60 * 1000);

const GUMROAD_RESUME_PERMALINK = process.env.GUMROAD_PRODUCT_PERMALINK_RESUME || "nktxk";
const GUMROAD_PRODUCT_PERMALINK = process.env.GUMROAD_PRODUCT_PERMALINK || "ubtedo";

// Put this near your other requires/helpers (fs is already required above)
function resolveChromiumPath() {
  // 1) if you set it via env (Dockerfile sets PUPPETEER_EXECUTABLE_PATH)
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;

  // 2) otherwise try common system locations (Debian/Heroku)
  const candidates = [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return null; // let puppeteer-core decide if it can
}

const exePath = resolveChromiumPath();
const browser = await puppeteer.launch({
  executablePath: exePath || undefined,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  headless: "new",
});


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
app.use(express.urlencoded({ extended: true }));

// ====== LO/GS/Poppler helpers ======
function resolveSofficeBin() {
  if (process.env.SOFFICE_BIN) return process.env.SOFFICE_BIN;
  const candidates = ["/usr/bin/libreoffice","/usr/bin/soffice","/usr/lib/libreoffice/program/soffice"];
  for (const p of candidates) { try { if (fs.existsSync(p)) return p; } catch {} }
  return "soffice";
}
const SOFFICE_CMD = resolveSofficeBin();
console.log("Resolved soffice path:", SOFFICE_CMD);

function runSoffice(args, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(SOFFICE_CMD, args, { env: { ...process.env, HOME: process.env.HOME || "/tmp" } });
    let stderr = "", stdout = "";
    const to = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} ; reject(new Error(`LibreOffice timeout after ${timeoutMs}ms`)); }, timeoutMs);
    child.stdout.on("data", d => (stdout += d.toString()));
    child.stderr.on("data", d => (stderr += d.toString()));
    child.on("error", err => { clearTimeout(to); reject(new Error(`Failed to start soffice (${SOFFICE_CMD}): ${err.message}`)); });
    child.on("close", code => { clearTimeout(to); if (code === 0) resolve({ stdout, stderr }); else reject(new Error(`soffice exited with code ${code}\n${stderr || stdout}`)); });
  });
}

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
      "-dNOPAUSE","-dQUIET","-dBATCH",
      "-dDetectDuplicateImages=true",
      "-dCompressFonts=true",
      "-dSubsetFonts=true",
      "-dDownsampleColorImages=true", `-dColorImageResolution=${colorRes}`,
      "-dDownsampleGrayImages=true",  `-dGrayImageResolution=${grayRes}`,
      "-dDownsampleMonoImages=true",  `-dMonoImageResolution=${monoRes}`,
      "-dNumRenderingThreads=2",      // use 2 threads on Basic dyno
      "-dFastWebView=true",           // linearize for faster first-byte
      `-sOutputFile=${outputPath}`,
      inputPath
    ];

    const child = spawn("gs", args);
    let stderr = "";
    child.stderr.on("data", d => (stderr += d.toString()));
    child.on("error", err => reject(err));
    child.on("close", code => { if (code === 0) resolve(); else reject(new Error(`Ghostscript exited ${code}: ${stderr}`)); });
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


function fullJsonPrompt(inputs) {
  const {
    fullName = "", email = "", phone = "", location = "",
    role = "", yearsExp = "",
    skills = "", achievements = "", experienceText = "", educationText = "",
    linkedin = "", github = "", portfolio = "",
    areaOfExpertise = ""
  } = inputs;

  return `
You are a senior technical recruiter AND professional resume writer with deep ATS knowledge.
Your task: transform the raw inputs into a concise, high-impact, ATS-optimized resume **JSON**.

# Candidate (verbatim user data)
- Name: ${fullName}
- Email: ${email}
- Phone: ${phone}
- Location: ${location}
- Target role: ${role}
- Years of experience: ${yearsExp}
- Skills (comma-separated): ${skills}
- Area of expertise (comma-separated): ${areaOfExpertise}
- Achievements (raw text): ${achievements}
- Experience (raw text): ${experienceText}
- Education (raw text): ${educationText}
- Links: LinkedIn ${linkedin} | GitHub ${github} | Portfolio ${portfolio}

# Output FORMAT (STRICT)
Return **ONLY** a single JSON object with exactly these keys (arrays may be empty but must exist):
{
  "summary": "1 short paragraph (max ~60 words)",
  "areaOfExpertise": ["Theme A", "Theme B", "..."],
  "skills": ["Skill A", "Skill B", "..."],
  "experience": [
    { "company": "", "title": "", "start": "", "end": "", "bullets": ["...", "..."] }
  ],
  "education": [
    { "school": "", "degree": "", "start": "", "end": "" }
  ],
  "links": [
    { "label": "LinkedIn", "url": "" },
    { "label": "GitHub", "url": "" },
    { "label": "Portfolio", "url": "" }
  ]
}

# Global RULES (apply to all sections)
- **Truthful only**: never invent employers, titles, dates, degrees, or metrics. If unknown, use "" or skip the item.
- **ATS-safe**: no tables, emoji, fancy symbols; plain text only.
- **Role targeting**: prioritize content aligned with "${role}".
- **Dates**: format as "MMM YYYY" (e.g., "Jan 2022"). If unknown, use "" (empty string).
- **Numbers**: prefer actual numbers from input; if implied ranges exist, use "≈" (e.g., "reduced cost by ≈15%") only when clearly supported by the raw text.
- **Voice/Tense**: use present tense for current role, past tense for past roles. No first-person pronouns.
- **Length discipline**:
  - summary ≤ ~60 words
  - 4–6 bullets for the most recent role; 3–5 for earlier roles
  - each bullet ≤ ~22 words
- **Keyword hygiene**: include hard skills relevant to the target role; dedupe; use common ATS tokens (e.g., "JavaScript" not "JS" unless both are valuable).
- **Consistency**: company/title capitalization; American English spelling; consistent punctuation.
- **Links**: include URLs only if provided and look valid (http/https). Otherwise set url to "".
- **No filler**: avoid clichés ("hard-working," "team player"), unless explicitly in the user text.

# Section-Specific RULES

## summary
- 1 short paragraph that positions the candidate for "${role}".
- Front-load impact (scope, seniority, core stack, best proof point).
- Include 1–2 most important keywords for ATS matching.

## areaOfExpertise
- 4–8 concise themes (e.g., "Backend Architecture", "Generative AI", "Growth Analytics").
- Derived from skills + experienceText; no fluff.

## skills
- Normalize & dedupe; group only as flat array of strings (no categories).
- Prefer canonical names (e.g., "Node.js", "React", "PostgreSQL", "AWS", "Kubernetes").
- Keep 10–18 items, sorted: core stack first, then complementary tools.

## experience
- Parse roles chronologically (most recent first). If multiple employers are unclear, infer separate entries only when text clearly separates them.
- "start"/"end" use "MMM YYYY" or "".
- Bullets follow **Impact-first STAR** style: **Result → how → scale**.
  Examples patterns:
  - "Increased X by Y% by doing Z at scale N."
  - "Reduced cost/time by X via Y, impacting N users/markets."
  - "Delivered feature X (A/B tested), improving metric Y (p-value if stated)."
- Use concrete nouns, action verbs (Led, Built, Architected, Automated, Optimized, Scaled, Refactored, Deployed).
- If the raw text mixes responsibilities and achievements, prioritize **quantified achievements**. Responsibilities only if needed for context.

## education
- Include degrees and schools that appear in the input. If missing dates, leave "".
- Certifications may be omitted unless clearly present in educationText.

## links
- Preserve the three labels exactly: "LinkedIn", "GitHub", "Portfolio".
- Use the provided values if they look like URLs; else set "".

# Data Cleaning / Normalization
- Trim whitespace; remove duplicates.
- Standardize tech names (e.g., "Javascript" → "JavaScript", "Postgres" → "PostgreSQL").
- For overlapping items (e.g., "LLMs", "Large Language Models"), prefer the more ATS-friendly variant or keep both if valuable.

# Examples of bullet rewriting (style guide)
- Weak: "Worked on API performance."
- Strong: "Cut P95 API latency from 820ms → 240ms by adding Redis caching and query plans; improved checkout CVR by 3.1%."

- Weak: "Responsible for data pipelines."
- Strong: "Built CDC pipelines in Airflow/Spark, reducing daily ETL runtime 47% and saving ≈$1.2k/month in compute."

# IMPORTANT
- If any field is unknown, **use an empty string** (""), not "N/A".
- Output **ONLY** the JSON object with the exact keys shown above—no commentary, no markdown, no code fences.
`;
}

// ---------- RESUME (same endpoints/behavior) ----------
app.post("/api/ai/resume/prepare", express.json(), async (req, res) => {
  try {
    const inputs = req.body || {};
    const ticket = (randomUUID ? randomUUID() : String(Date.now()+Math.random())).replace(/-/g,"");
    resumeTickets.set(ticket, { paid: false, createdAt: Date.now(), inputs });
    const buyUrl = `https://gumroad.com/l/${encodeURIComponent(GUMROAD_RESUME_PERMALINK || GUMROAD_PRODUCT_PERMALINK)}?wanted=true&ticket=${encodeURIComponent(ticket)}&fields[ticket]=${encodeURIComponent(ticket)}`;
    console.log("RESUME PREPARE", { ticket, buyUrl });
    return res.json({ ticket, buyUrl });
  } catch (e) {
    console.error("resume prepare error:", e);
    return res.status(500).json({ error: "Failed to init resume purchase" });
  }
});

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
  } catch (e) { console.warn("reconcileGumroadPaymentForResume error:", e.message); }
  return false;
}

app.get("/api/ai/resume/status", async (req, res) => {
  const ticket = String(req.query.ticket || "");
  const rec = resumeTickets.get(ticket);
  if (!rec) return res.status(404).json({ error: "Invalid ticket" });

  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  res.set("Surrogate-Control", "no-store");

  if (!rec.paid) {
    try { const paidNow = await reconcileGumroadPaymentForResume(ticket);
      if (paidNow) { rec.paid = true; console.log("RESUME STATUS: payment reconciled from Gumroad API", { ticket }); }
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

    let json = rec?.inputs?.previewJson;
    if (!json) {
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

    const buf = await buildATSResumeDocxCompact({
      fullName: rec.inputs.fullName,
      email: rec.inputs.email,
      phone: rec.inputs.phone,
      location: rec.inputs.location,
      role: rec.inputs.role,
      summary: json.summary || "",
      skills: Array.isArray(json.skills) ? json.skills : [],
      experience: Array.isArray(json.experience) ? json.experience : [],
      education: Array.isArray(json.education) ? json.education : [],
      links: Array.isArray(json.links) ? json.links : [],
      areaOfExpertise: Array.isArray(json.areaOfExpertise) ? json.areaOfExpertise : [],
    });

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", `attachment; filename="resume.docx"`);
    return res.send(buf);
  } catch (e) {
    console.error("resume download error:", e);
    return res.status(500).json({ error: "Failed to generate resume" });
  }
});

app.post("/api/ai/resume/preview", express.json(), async (req, res) => {
  try {
    if (!openai) return res.status(500).json({ error: "AI not configured" });
    const inputs = req.body || {};
    const prompt = fullJsonPrompt(inputs);
    const resp = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      max_tokens: 900,
      response_format: { type: "json_object" }
    });

    let json = {};
    try { json = JSON.parse(resp.choices?.[0]?.message?.content || "{}"); } catch {}

    if (!Array.isArray(json.skills)) json.skills = String(inputs.skills || "").split(",").map(s=>s.trim()).filter(Boolean);
    if (!Array.isArray(json.areaOfExpertise) || json.areaOfExpertise.length === 0) {
      json.areaOfExpertise = String(inputs.areaOfExpertise || "").split(",").map(s=>s.trim()).filter(Boolean);
    }
    if (!Array.isArray(json.links) || json.links.length === 0) {
      json.links = [
        inputs.linkedin && { label: "LinkedIn", url: inputs.linkedin },
        inputs.github &&   { label: "GitHub", url: inputs.github },
        inputs.portfolio &&{ label: "Portfolio", url: inputs.portfolio },
      ].filter(Boolean);
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
      links: json.links || [],
      areaOfExpertise: json.areaOfExpertise || [],
    });

    return res.json({ json, html });
  } catch (e) {
    console.error("resume preview error:", e);
    return res.status(500).json({ error: "Failed to build preview" });
  }
});

// ---------- FREE TOOLS (unchanged routes; improved internals) ----------

/** Remove pages */
app.post("/api/remove-pages", upload.single("file"), async (req, res) => {
  try {
    const filePath = req.file.path;
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

    const outFile = path.join(OUTDIR, `merged-${Date.now()}.pdf`);
    const mergedBytes = await mergedPdf.save();
    fs.writeFileSync(outFile, mergedBytes);

    streamFile(res, outFile, "merged.pdf", "application/pdf");
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to merge PDFs" });
  }
});

/** DOCX -> PDF */
app.post("/api/convert/docx-to-pdf", upload.single("file"), limitHeavy(async (req, res) => {
  const tmpPath = req.file?.path;
  if (!tmpPath) return res.status(400).json({ error: "No file uploaded" });

  const origName = req.file.originalname || "input.docx";
  const baseNoExt = path.parse(origName).name;
  const jobDir = fs.mkdtempSync(path.join(BASE_TMP, "lo-"));

  try {
    await runSoffice([
      "--headless","--nologo",
      "-env:UserInstallation=file:///tmp/lo_profile",
      "--convert-to","pdf",
      "--outdir", jobDir,
      tmpPath
    ]);

    const outFile =
      findConverted(jobDir, baseNoExt, "pdf") ||
      findConverted(jobDir, path.parse(tmpPath).name, "pdf");

    if (!outFile || !fs.existsSync(outFile)) throw new Error("Conversion output not found");

    streamFile(res, outFile, "converted.pdf", "application/pdf");
  } catch (e) {
    console.error("docx->pdf error:", e.message);
    res.status(500).json({
      error: e.message.includes("soffice")
        ? "Converter not available on server"
        : `Conversion failed: ${e.message}`
    });
  } finally {
    try { fs.unlinkSync(tmpPath); } catch {}
    try { rmSync(jobDir, { recursive: true, force: true }); } catch {}
  }
}));

/** PDF -> DOCX (LibreOffice baseline, free) */
app.post("/api/convert/pdf-to-docx", upload.single("file"), limitHeavy(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  const tmpPath = req.file.path;
  const origName = req.file.originalname || "input.pdf";
  const baseNoExt = path.parse(origName).name;
  const jobDir = fs.mkdtempSync(path.join(BASE_TMP, "lo-"));

  try {
    await runSoffice([
      "--headless","--nologo",
      "-env:UserInstallation=file:///tmp/lo_profile",
      "--convert-to","docx",
      "--outdir", jobDir,
      tmpPath
    ]);

    const outFile =
      findConverted(jobDir, baseNoExt, "docx") ||
      findConverted(jobDir, path.parse(tmpPath).name, "docx");

    if (!outFile || !fs.existsSync(outFile)) throw new Error("Conversion output not found");

    streamFile(res, outFile, "converted.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  } catch (e) {
    console.error("pdf->docx error:", e.message);
    res.status(500).json({ error: "Conversion failed: " + e.message });
  } finally {
    try { fs.unlinkSync(tmpPath); } catch {}
    try { rmSync(jobDir, { recursive: true, force: true }); } catch {}
  }
}));

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

/** compress image (PNG lossless first, optional lossy fallback when no alpha) */
app.post("/api/compress/image", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  const targetKb = Math.max(50, parseInt(req.body.targetKb || "500", 10));
  const allowLossyIfNoAlpha = String(req.body.allowLossyIfNoAlpha || "false").toLowerCase() === "true";
  let requestedFormat = String((req.body.format || "webp")).toLowerCase();
  if (requestedFormat === "jpg") requestedFormat = "jpeg";
  if (!["webp", "jpeg", "png"].includes(requestedFormat)) requestedFormat = "webp";
  let lossyFallback = String((req.body.lossyFallback || "webp")).toLowerCase();
  if (lossyFallback === "jpg") lossyFallback = "jpeg";
  if (!["webp", "jpeg"].includes(lossyFallback)) lossyFallback = "webp";

  const inPath = req.file.path;

  try {
    const input = fs.readFileSync(inPath);
    const meta = await sharp(input).metadata();
    const hasAlpha = !!meta.hasAlpha;
    let width = meta.width || 2000;

    // runtime tuning
    sharp.cache({ files: 0, items: 0, memory: 64 });
    sharp.concurrency(2);

    const MAX_ATTEMPTS = 10;
    const MAX_LOSSY_ATTEMPTS = 6;

    let attempt = 0;
    let outBuf = null;
    let lastLen = Infinity;
    let finalFormat = requestedFormat;

    let quality = 82;         // webp/jpeg
    let compressionLevel = 6; // png 0..9
    let colors = 256;         // png palette

    async function encodeOnce(fmt, candidateWidth) {
      let pipeline = sharp(input).resize(candidateWidth, null, { fit: "inside", withoutEnlargement: true });
      if (fmt === "webp") pipeline = pipeline.webp({ quality, effort: 4 });
      else if (fmt === "jpeg") pipeline = (hasAlpha ? pipeline.flatten({ background: "#ffffff" }) : pipeline).jpeg({ quality, mozjpeg: true });
      else if (fmt === "png") pipeline = pipeline.png({ compressionLevel: Math.min(9, compressionLevel), palette: true, colors: Math.max(16, colors) });
      return pipeline.toBuffer();
    }

    while (attempt < MAX_ATTEMPTS) {
      const shrinkPhase = Math.max(0, attempt - 3);
      const candidateWidth = shrinkPhase === 0 ? width : Math.max(600, Math.floor(width * Math.pow(0.85, shrinkPhase)));
      outBuf = await encodeOnce(finalFormat, candidateWidth);

      if (outBuf.length <= targetKb * 1024) break;
      if (outBuf.length >= lastLen) break;
      lastLen = outBuf.length;

      if (finalFormat === "webp" || finalFormat === "jpeg") {
        quality = Math.max(45, quality - 8);
      } else if (finalFormat === "png") {
        colors = Math.max(16, Math.floor(colors / 2));
        compressionLevel = Math.min(9, compressionLevel + 1);
      }
      attempt++;
    }

    if (finalFormat === "png" && allowLossyIfNoAlpha && !hasAlpha && outBuf && outBuf.length > targetKb * 1024) {
      finalFormat = lossyFallback;
      quality = 82; lastLen = Infinity;
      let lossyAttempt = 0;
      while (lossyAttempt < MAX_LOSSY_ATTEMPTS) {
        const shrinkPhase = Math.max(0, lossyAttempt - 2);
        const candidateWidth = shrinkPhase === 0 ? width : Math.max(600, Math.floor(width * Math.pow(0.85, shrinkPhase)));
        const buf = await encodeOnce(finalFormat, candidateWidth);
        if (buf.length <= targetKb * 1024) { outBuf = buf; break; }
        if (buf.length >= lastLen) { outBuf = buf; break; }
        lastLen = buf.length;
        quality = Math.max(45, quality - 8);
        lossyAttempt++; outBuf = buf;
      }
    }

    if (!outBuf) outBuf = input;

    const ct = finalFormat === "webp" ? "image/webp" : finalFormat === "jpeg" ? "image/jpeg" : "image/png";
    const ext = finalFormat === "webp" ? "webp" : finalFormat === "jpeg" ? "jpg" : "png";
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
app.post("/api/compress/pdf", upload.single("file"), limitHeavy(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  const targetKb = Math.max(100, parseInt(req.body.targetKb || "500", 10));

  const inPath = req.file.path;
  const outPath = path.join(OUTDIR, `${path.parse(inPath).name}-compressed.pdf`);

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
    try { fs.unlinkSync(outPath); } catch {}
  } finally {
    try { fs.unlinkSync(inPath); } catch {}
  }
}));

/** images -> pdf */
app.post("/api/convert/images-to-pdf", upload.array("files"), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "Please upload at least one image." });
    }

    const pdfDoc = await PDFDocument.create();

    for (const f of req.files) {
      const bytes = fs.readFileSync(f.path);
      let img;
      if ((f.mimetype || "").includes("jpeg") || f.originalname.toLowerCase().endsWith(".jpg")) {
        img = await pdfDoc.embedJpg(bytes);
      } else if ((f.mimetype || "").includes("png") || f.originalname.toLowerCase().endsWith(".png")) {
        img = await pdfDoc.embedPng(bytes);
      } else {
        try { img = await pdfDoc.embedJpg(bytes); } catch { img = await pdfDoc.embedPng(bytes); }
      }
      const dims = img.scale(1);

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

    const outFile = path.join(OUTDIR, `images-${Date.now()}.pdf`);
    const out = await pdfDoc.save();
    fs.writeFileSync(outFile, out);

    for (const f of req.files) { try { fs.unlinkSync(f.path); } catch {} }
    streamFile(res, outFile, "images.pdf", "application/pdf");
  } catch (e) {
    console.error("images->pdf error:", e);
    res.status(500).json({ error: "Failed to build PDF from images" });
  }
});

/** pdf -> images (zip) */
app.post("/api/convert/pdf-to-images", upload.single("file"), limitHeavy(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  const pdfPath = req.file.path;
  const tmpDir = mkdtempSync(path.join(BASE_TMP, "pdfimgs-"));
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

    for (const f of files) archive.file(path.join(tmpDir, f), { name: f });
    await archive.finalize();
  } catch (e) {
    console.error("pdf->images error:", e);
    res.status(500).json({ error: "Failed to convert PDF to images" });
  } finally {
    try { fs.unlinkSync(pdfPath); } catch {}
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}));

// ===================== PRO (CloudConvert + Gumroad) =====================

app.post("/api/pro/prepare", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  if (!process.env.CLOUDCONVERT_API_KEY) return res.status(500).json({ error: "CloudConvert not configured" });

  const ticket = randomUUID().replace(/-/g, "");
  const origName = req.file.originalname || "input.pdf";

  try {
    const job = await cloudConvert.jobs.create({
      tasks: {
        'import-1': { operation: 'import/upload' },
        'convert-1': { operation: 'convert', input: 'import-1', input_format: 'pdf', output_format: 'docx' },
        'export-1': { operation: 'export/url', input: 'convert-1' }
      }
    });

    const uploadTask = job.tasks.find(t => t.name === 'import-1');
    await cloudConvert.tasks.upload(uploadTask, fs.createReadStream(req.file.path), origName);
    try { fs.unlinkSync(req.file.path); } catch {}

    tickets.set(ticket, { jobId: job.id, paid: false, ready: false, file: null, createdAt: Date.now(), error: null });

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
    console.log("PRO PREPARE RESP:", { ticket, buyUrl });
    return res.json({ ticket, buyUrl });
  } catch (e) {
    console.error("pro/prepare error:", e);
    try { fs.unlinkSync(req.file.path); } catch {}
    return res.status(500).json({ error: "Failed to initialize conversion" });
  }
});

async function reconcileGumroadPayment(ticket) {
  try {
    if (!process.env.GUMROAD_ACCESS_TOKEN) return false;
    const token = process.env.GUMROAD_ACCESS_TOKEN;
    const permalink = process.env.GUMROAD_PRODUCT_PERMALINK;
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
  } catch (e) { console.warn("reconcileGumroadPayment error:", e.message); }
  return false;
}

app.get("/api/pro/status", async (req, res) => {
  const ticket = String(req.query.ticket || "");
  const rec = tickets.get(ticket);
  if (!rec) return res.status(404).json({ error: "Invalid ticket" });

  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  res.set("Surrogate-Control", "no-store");

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
  } catch {}

  try {
    if (!rec.paid) {
      const paidNow = await reconcileGumroadPayment(ticket);
      if (paidNow) { rec.paid = true; console.log("STATUS: payment reconciled from Gumroad API", { ticket }); }
    }
  } catch {}

  return res.status(200).json({ paid: rec.paid, ready: rec.ready, error: rec.error || null });
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

// === FREE: exact-preview PDF (HTML → PDF via headless Chrome) ===
app.post("/api/ai/resume/pdf", express.json({ limit: "1mb" }), async (req, res) => {
  try {
    let { html, previewJson, ...inputs } = req.body || {};

    // If caller didn't send html, rebuild it so we still work:
    if (!html) {
      // If no previewJson, try to generate (keeps behavior compatible)
      if (!previewJson) {
        if (!openai) return res.status(500).json({ error: "AI not configured" });
        const prompt = fullJsonPrompt(inputs || {});
        const resp = await openai.chat.completions.create({
          model: "gpt-4o",
          messages: [{ role: "user", content: prompt }],
          temperature: 0.2,
          max_tokens: 900,
          response_format: { type: "json_object" }
        });
        previewJson = JSON.parse(resp.choices?.[0]?.message?.content || "{}");
      }

      // normalize json like your preview route does
      if (!Array.isArray(previewJson.skills)) {
        previewJson.skills = String(inputs.skills || "").split(",").map(s=>s.trim()).filter(Boolean);
      }
      if (!Array.isArray(previewJson.areaOfExpertise) || previewJson.areaOfExpertise.length === 0) {
        previewJson.areaOfExpertise = String(inputs.areaOfExpertise || "")
          .split(",").map(s=>s.trim()).filter(Boolean);
      }
      if (!Array.isArray(previewJson.links) || previewJson.links.length === 0) {
        previewJson.links = [
          inputs.linkedin && { label: "LinkedIn", url: inputs.linkedin },
          inputs.github && { label: "GitHub", url: inputs.github },
          inputs.portfolio && { label: "Portfolio", url: inputs.portfolio },
        ].filter(Boolean);
      }

      html = buildResumeHTML({
        fullName: inputs.fullName,
        email: inputs.email,
        phone: inputs.phone,
        location: inputs.location,
        role: inputs.role,
        summary: previewJson.summary || "",
        skills: previewJson.skills || [],
        experience: Array.isArray(previewJson.experience) ? previewJson.experience : [],
        education: Array.isArray(previewJson.education) ? previewJson.education : [],
        links: previewJson.links || [],
        areaOfExpertise: previewJson.areaOfExpertise || [],
      });
    }

    // Launch Chromium (Heroku/docker: use system binary + no-sandbox)
    const exePath = resolveChromiumPath();
    const browser = await puppeteer.launch({
      executablePath: exePath || undefined,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
      headless: "new",
    });

    const page = await browser.newPage();

    // Ensure fonts/backgrounds render as seen
    await page.emulateMediaType("screen");
    await page.setContent(html, { waitUntil: "networkidle0" });

    // PDF of the full preview page, including background + shadow (exact look)
    const pdfBuf = await page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: "0.4in", right: "0.4in", bottom: "0.4in", left: "0.4in" },
    });

    await browser.close();

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="resume.pdf"');
    return res.send(pdfBuf);
  } catch (e) {
    console.error("resume exact pdf error:", e);
    return res.status(500).json({ error: "Failed to render PDF" });
  }
});


// ---------- start ----------
const PORT = process.env.PORT || 4000;
const server = app.listen(PORT, () => console.log(`Backend running on :${PORT} (web=${WEB_CONCURRENCY}, heavy=${HEAVY_CONCURRENCY})`));
// keep-alive to play nice with Heroku router timeouts
server.keepAliveTimeout = 65_000;
server.headersTimeout   = 66_000;

// LibreOffice prewarm (improves first-request latency)
(async () => {
  try {
    const d = fs.mkdtempSync(path.join(BASE_TMP, "warm-"));
    const f = path.join(d, "x.txt"); fs.writeFileSync(f, "warm");
    await runSoffice(["--headless","--nologo","-env:UserInstallation=file:///tmp/lo_profile","--convert-to","pdf","--outdir", d, f]);
    rmSync(d, { recursive: true, force: true });
    console.log("LibreOffice prewarm done");
  } catch (e) { console.log("LO prewarm skipped:", e.message); }
})();


