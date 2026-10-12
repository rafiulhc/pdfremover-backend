// Resume rendering: HTML preview, ATS-friendly DOCX, and the OpenAI prompt.
const { Document, Packer, Paragraph, TextRun } = require("docx");

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

async function fetchResumeJsonText(openai, model, inputs) {
  const resp = await openai.chat.completions.create({
    model,
    messages: [{ role: "user", content: fullJsonPrompt(inputs || {}) }],
    temperature: 0.2,
    max_tokens: 900,
    response_format: { type: "json_object" }
  });
  return resp.choices?.[0]?.message?.content || "{}";
}

// Fills gaps in the model's JSON from the raw form inputs (mutates and returns json).
function normalizePreviewJson(json, inputs) {
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
  return json;
}

function previewHtml(inputs, json) {
  return buildResumeHTML({
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
}

function resumeDocx(inputs, json) {
  return buildATSResumeDocxCompact({
    fullName: inputs.fullName,
    email: inputs.email,
    phone: inputs.phone,
    location: inputs.location,
    role: inputs.role,
    summary: json.summary || "",
    skills: Array.isArray(json.skills) ? json.skills : [],
    experience: Array.isArray(json.experience) ? json.experience : [],
    education: Array.isArray(json.education) ? json.education : [],
    links: Array.isArray(json.links) ? json.links : [],
    areaOfExpertise: Array.isArray(json.areaOfExpertise) ? json.areaOfExpertise : [],
  });
}

module.exports = {
  buildResumeHTML, buildATSResumeDocxCompact, fullJsonPrompt,
  fetchResumeJsonText, normalizePreviewJson, previewHtml, resumeDocx,
};
