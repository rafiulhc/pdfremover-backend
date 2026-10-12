const { test } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { makeApp, makePdf, pageCount, makePng, binary } = require("./helpers");

test("GET /health is ok and not cached", async () => {
  const { app } = makeApp();
  const res = await request(app).get("/health").expect(200);
  assert.deepEqual(res.body, { status: "ok" });
  assert.equal(res.headers["cache-control"], "no-store");
});

test("GET /api/health works too (the path CloudFront routes to the backend)", async () => {
  const { app } = makeApp();
  await request(app).get("/api/health").expect(200, { status: "ok" });
});

test("debug route that leaked server details is gone", async () => {
  const { app } = makeApp();
  await request(app).get("/api/debug/soffice").expect(404);
});

test("remove-pages drops the requested 1-based pages", async () => {
  const { app } = makeApp();
  const res = await request(app)
    .post("/api/remove-pages")
    .field("pagesToRemove", "2, 4")
    .attach("file", await makePdf(5), "in.pdf")
    .buffer(true).parse(binary)
    .expect(200)
    .expect("Content-Type", "application/pdf");
  assert.equal(await pageCount(res.body), 3);
});

test("remove-pages without a file is a 400, not a crash", async () => {
  const { app } = makeApp();
  await request(app).post("/api/remove-pages").field("pagesToRemove", "1").expect(400);
});

test("merge-pdfs concatenates pages in upload order", async () => {
  const { app } = makeApp();
  const res = await request(app)
    .post("/api/merge-pdfs")
    .attach("files", await makePdf(2), "a.pdf")
    .attach("files", await makePdf(3), "b.pdf")
    .buffer(true).parse(binary)
    .expect(200)
    .expect("Content-Disposition", 'attachment; filename="merged.pdf"');
  assert.equal(await pageCount(res.body), 5);
});

test("merge-pdfs needs at least two files", async () => {
  const { app } = makeApp();
  const res = await request(app)
    .post("/api/merge-pdfs")
    .attach("files", await makePdf(1), "a.pdf")
    .expect(400);
  assert.match(res.body.error, /at least two/);
});

test("images-to-pdf makes one page per image", async () => {
  const { app } = makeApp();
  const res = await request(app)
    .post("/api/convert/images-to-pdf")
    .attach("files", await makePng(), "a.png")
    .attach("files", await makePng(30, 90), "b.png")
    .buffer(true).parse(binary)
    .expect(200);
  assert.equal(await pageCount(res.body), 2);
});

test("compress/image defaults to webp", async () => {
  const { app } = makeApp();
  const res = await request(app)
    .post("/api/compress/image")
    .attach("file", await makePng(400, 300), "a.png")
    .buffer(true).parse(binary)
    .expect(200)
    .expect("Content-Type", "image/webp");
  assert.ok(res.body.length > 0);
});

test("uploads over the size limit get 413", async () => {
  const { app } = makeApp({}, { UPLOAD_MAX_MB: "0" });
  await request(app)
    .post("/api/remove-pages")
    .attach("file", await makePdf(1), "in.pdf")
    .expect(413);
});

test("CORS allows the production site and not others", async () => {
  const { app } = makeApp();
  const ok = await request(app).get("/health").set("Origin", "https://www.pdfmergersplitter.app");
  assert.equal(ok.headers["access-control-allow-origin"], "https://www.pdfmergersplitter.app");
  const other = await request(app).get("/health").set("Origin", "https://evil.example");
  assert.equal(other.headers["access-control-allow-origin"], undefined);
});
