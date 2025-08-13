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
