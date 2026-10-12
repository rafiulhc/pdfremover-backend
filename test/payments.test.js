const { test } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { makeApp, makePdf, binary, fakeOpenAI } = require("./helpers");
const { extractTicket, reconcilePayment, buyUrl } = require("../src/services/gumroad");
const { createTicketStore } = require("../src/services/tickets");

const noSales = { get: async () => ({ data: { sales: [] } }) };

test("resume prepare returns a ticket and a Gumroad link carrying it", async () => {
  const { app } = makeApp({ http: noSales });
  const res = await request(app).post("/api/ai/resume/prepare").send({ fullName: "A" }).expect(200);
  assert.match(res.body.ticket, /^[0-9a-f]{32}$/);
  assert.equal(
    res.body.buyUrl,
    `https://gumroad.com/l/nktxk?wanted=true&ticket=${res.body.ticket}&fields[ticket]=${res.body.ticket}`,
  );
});

test("Gumroad ping marks a resume ticket paid; download then works", async () => {
  const openai = fakeOpenAI({ summary: "Engineer", skills: ["Node.js"] });
  const { app } = makeApp({ http: noSales, openai });
  const { body } = await request(app).post("/api/ai/resume/prepare").send({ fullName: "A" });

  let status = await request(app).get(`/api/ai/resume/status?ticket=${body.ticket}`).expect(200);
  assert.equal(status.body.paid, false);
  await request(app).get(`/api/ai/resume/download?ticket=${body.ticket}`).expect(402);

  await request(app)
    .post("/api/gumroad/ping")
    .type("form")
    .send({ price: "500", product_permalink: "https://x.gumroad.com/l/nktxk", "url_params[ticket]": body.ticket })
    .expect(200, "OK");

  status = await request(app).get(`/api/ai/resume/status?ticket=${body.ticket}`).expect(200);
  assert.equal(status.body.paid, true);
  assert.equal(status.headers["cache-control"], "no-store, no-cache, must-revalidate, proxy-revalidate");

  const doc = await request(app)
    .get(`/api/ai/resume/download?ticket=${body.ticket}`)
    .buffer(true).parse(binary)
    .expect(200);
  assert.equal(doc.body.subarray(0, 2).toString(), "PK"); // .docx is a zip
});

test("status reconciles payment from the Gumroad API when the ping was lost", async () => {
  let ticket;
  const http = { get: async () => ({ data: { sales: [{ url_params: { ticket }, refunded: false }] } }) };
  const { app } = makeApp({ http }, { GUMROAD_ACCESS_TOKEN: "t" });
  ({ body: { ticket } } = await request(app).post("/api/ai/resume/prepare").send({}));
  const res = await request(app).get(`/api/ai/resume/status?ticket=${ticket}`).expect(200);
  assert.equal(res.body.paid, true);
});

test("unknown tickets are 404", async () => {
  const { app } = makeApp();
  await request(app).get("/api/ai/resume/status?ticket=nope").expect(404);
  await request(app).get("/api/pro/status?ticket=nope").expect(404);
  await request(app).get("/api/pro/download?ticket=nope").expect(404);
});

test("ping rejects zero price and ignores refunds", async () => {
  const { app } = makeApp();
  await request(app).post("/api/gumroad/ping").type("form").send({ price: "0" }).expect(400);
  await request(app).post("/api/gumroad/ping").type("form")
    .send({ price: "100", refunded: "true" }).expect(200, "Ignored (refunded)");
});

test("pro flow: prepare -> not paid -> paid but not ready -> ready -> download", async () => {
  const exportFile = { url: "https://cc.example/out.docx", filename: 'my"file.docx' };
  let finished = false;
  const cloudConvert = {
    jobs: {
      create: async () => ({ id: "job1", tasks: [{ name: "import-1" }] }),
      wait: () => new Promise(() => {}), // never resolves; status refresh handles readiness
      get: async () => ({ finished }),
      getExportUrls: (job) => (job.finished ? [exportFile] : []),
    },
    // Like the real SDK, read the whole upload before resolving.
    tasks: { upload: (_task, stream) => require("stream/promises").finished(stream.resume()) },
  };
  const { Readable } = require("stream");
  const http = {
    get: async (url) => url.startsWith("https://api.gumroad.com")
      ? { data: { sales: [] } }
      : { data: Readable.from([Buffer.from("DOCX")]) },
  };
  const { app } = makeApp({ cloudConvert, http }, { CLOUDCONVERT_API_KEY: "k" });

  const { body } = await request(app)
    .post("/api/pro/prepare")
    .attach("file", await makePdf(1), "in.pdf")
    .expect(200);
  assert.equal(body.buyUrl, `https://gumroad.com/l/ubtedo?wanted=true&ticket=${body.ticket}`);

  await request(app).get(`/api/pro/download?ticket=${body.ticket}`).expect(402);
  await request(app).post("/api/gumroad/ping").type("form").send({ price: "300", ticket: body.ticket }).expect(200, "OK");
  await request(app).get(`/api/pro/download?ticket=${body.ticket}`).expect(425);

  finished = true;
  const status = await request(app).get(`/api/pro/status?ticket=${body.ticket}`).expect(200);
  assert.deepEqual(status.body, { paid: true, ready: true, error: null });

  const dl = await request(app).get(`/api/pro/download?ticket=${body.ticket}`).expect(200);
  assert.equal(dl.headers["content-disposition"], 'attachment; filename="my_file.docx"');
});

test("pro prepare without CloudConvert configured is a clear 500", async () => {
  const { app } = makeApp();
  const res = await request(app).post("/api/pro/prepare").attach("file", await makePdf(1), "in.pdf").expect(500);
  assert.equal(res.body.error, "CloudConvert not configured");
});

test("extractTicket finds the ticket wherever Gumroad puts it", () => {
  assert.equal(extractTicket({ url_params: { ticket: "a" } }), "a");
  assert.equal(extractTicket({ url_params: '{"ticket":"b"}' }), "b");
  assert.equal(extractTicket({ custom_fields: { TICKET: "c" } }), "c");
  assert.equal(extractTicket({ "fields[ticket]": "d" }), "d");
  assert.equal(extractTicket({ ticket: "e" }), "e");
  assert.equal(extractTicket({}), undefined);
});

test("reconcilePayment ignores refunded sales and missing tokens", async () => {
  const http = { get: async () => ({ data: { sales: [{ url_params: { ticket: "t" }, refunded: "true" }] } }) };
  assert.equal(await reconcilePayment({ http, accessToken: "x", permalink: "p", ticket: "t" }), false);
  assert.equal(await reconcilePayment({ http, accessToken: "", permalink: "p", ticket: "t" }), false);
  assert.equal(buyUrl("a b", "t"), "https://gumroad.com/l/a%20b?wanted=true&ticket=t");
});

test("ticket store sweeps expired tickets", () => {
  const store = createTicketStore({ ttlMs: 1000 });
  store.set("old", { createdAt: 0 });
  store.set("new", { createdAt: 5000 });
  store.sweep(5500);
  assert.equal(store.get("old"), undefined);
  assert.ok(store.get("new"));
  assert.equal(store.size, 1);
});
