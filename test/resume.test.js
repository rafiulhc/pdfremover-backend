const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const request = require("supertest");
const { makeApp, binary, fakeOpenAI } = require("./helpers");
const { buildResumeHTML, normalizePreviewJson } = require("../src/services/resume");
const { createBrowser } = require("../src/lib/browser");
const { createLimit } = require("../src/lib/limit");

test("preview fills gaps from the form inputs and escapes HTML", async () => {
  const openai = fakeOpenAI({ summary: "<script>x</script>" });
  const { app } = makeApp({ openai });
  const res = await request(app)
    .post("/api/ai/resume/preview")
    .send({ fullName: "Ada", skills: "Node.js, SQL", linkedin: "https://linkedin.com/in/ada" })
    .expect(200);
  assert.deepEqual(res.body.json.skills, ["Node.js", "SQL"]);
  assert.deepEqual(res.body.json.links, [{ label: "LinkedIn", url: "https://linkedin.com/in/ada" }]);
  assert.ok(res.body.html.includes("&lt;script&gt;"));
  assert.ok(!res.body.html.includes("<script>x"));
});

test("preview without an OpenAI key says so", async () => {
  const { app } = makeApp();
  const res = await request(app).post("/api/ai/resume/preview").send({}).expect(500);
  assert.equal(res.body.error, "AI not configured");
});

test("resume/pdf renders the given HTML through the browser", async () => {
  let rendered;
  const browser = { htmlToPdf: async (html) => { rendered = html; return Buffer.from("%PDF-1.7"); } };
  const { app } = makeApp({ browser });
  const res = await request(app)
    .post("/api/ai/resume/pdf")
    .send({ html: "<p>hi</p>" })
    .buffer(true).parse(binary)
    .expect(200)
    .expect("Content-Type", "application/pdf");
  assert.equal(rendered, "<p>hi</p>");
  assert.equal(res.body.toString(), "%PDF-1.7");
});

test("resume/pdf builds HTML from previewJson when none is sent", async () => {
  let rendered;
  const browser = { htmlToPdf: async (html) => { rendered = html; return Buffer.from("%PDF"); } };
  const { app } = makeApp({ browser });
  await request(app)
    .post("/api/ai/resume/pdf")
    .send({ fullName: "Ada", previewJson: { summary: "Builds things" } })
    .expect(200);
  assert.ok(rendered.includes("Ada") && rendered.includes("Builds things"));
});

test("normalizePreviewJson keeps model output when present", () => {
  const json = normalizePreviewJson({ skills: ["Go"], areaOfExpertise: ["APIs"], links: [{ label: "x", url: "y" }] }, { skills: "Rust" });
  assert.deepEqual(json.skills, ["Go"]);
  assert.ok(buildResumeHTML({ fullName: "A", ...json }).includes("APIs"));
});

test("createLimit never runs more than N jobs at once", async () => {
  const limit = createLimit(2);
  let active = 0, peak = 0;
  const job = () => limit(async () => {
    active++; peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 10));
    active--;
  });
  await Promise.all(Array.from({ length: 6 }, job));
  assert.equal(peak, 2);
});

// Real Chromium; skipped when none is installed (CI runs it inside the Docker image).
const chrome = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find((p) => p && fs.existsSync(p));

test("untrusted resume HTML cannot make network requests (SSRF)", { skip: !chrome && "no Chromium" }, async () => {
  let hits = 0;
  const server = http.createServer((_req, res) => { hits++; res.end("x"); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const browser = createBrowser({ chromiumPath: chrome });
  try {
    const pdf = await browser.htmlToPdf(`<img src="${url}/img"><link rel="stylesheet" href="${url}/css"><p>ok</p>`);
    assert.equal(Buffer.from(pdf).subarray(0, 4).toString(), "%PDF");
    assert.equal(hits, 0);
  } finally {
    await browser.close();
    server.close();
  }
});
