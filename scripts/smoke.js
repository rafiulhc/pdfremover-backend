// Smoke test against a running server, including the routes that need LibreOffice,
// Ghostscript, Poppler and Chromium (so run it against the Docker image).
//   node scripts/smoke.js http://localhost:4000
const { PDFDocument, StandardFonts } = require("pdf-lib");
const { Document, Packer, Paragraph } = require("docx");

const base = (process.argv[2] || "http://localhost:4000").replace(/\/$/, "");

async function samplePdf(pages = 2) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i++) doc.addPage([300, 300]).drawText(`Page ${i}`, { x: 50, y: 150, size: 24, font });
  return Buffer.from(await doc.save());
}

async function post(path, files, fields = {}) {
  const form = new FormData();
  for (const [name, buf, filename] of files) form.append(name, new Blob([buf]), filename);
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  const res = await fetch(base + path, { method: "POST", body: form });
  return { status: res.status, type: res.headers.get("content-type"), body: Buffer.from(await res.arrayBuffer()) };
}

const checks = [
  ["health", async () => (await fetch(`${base}/api/health`)).status === 200],
  ["docx-to-pdf", async () => {
    const docx = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph("hello")] }] }));
    const r = await post("/api/convert/docx-to-pdf", [["file", docx, "hello.docx"]]);
    return r.status === 200 && r.body.subarray(0, 4).toString() === "%PDF";
  }],
  ["pdf-to-docx", async () => {
    const r = await post("/api/convert/pdf-to-docx", [["file", await samplePdf(), "a.pdf"]]);
    return r.status === 200 && r.body.subarray(0, 2).toString() === "PK";
  }],
  ["compress/pdf", async () => {
    const r = await post("/api/compress/pdf", [["file", await samplePdf(), "a.pdf"]], { targetKb: "100" });
    return r.status === 200 && r.body.subarray(0, 4).toString() === "%PDF";
  }],
  ["pdf-to-images", async () => {
    const r = await post("/api/convert/pdf-to-images", [["file", await samplePdf(3), "a.pdf"]]);
    return r.status === 200 && r.type === "application/zip" && r.body.subarray(0, 2).toString() === "PK";
  }],
  ["resume/pdf (Chromium)", async () => {
    const res = await fetch(`${base}/api/ai/resume/pdf`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ html: "<h1>Smoke</h1>" }),
    });
    return res.status === 200 && Buffer.from(await res.arrayBuffer()).subarray(0, 4).toString() === "%PDF";
  }],
];

(async () => {
  let failed = 0;
  for (const [name, check] of checks) {
    const t = Date.now();
    let ok = false;
    try { ok = await check(); } catch (e) { console.error(e.message); }
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}  ${Date.now() - t} ms`);
    if (!ok) failed++;
  }
  process.exit(failed ? 1 : 0);
})();
