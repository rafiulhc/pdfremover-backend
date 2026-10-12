const sharp = require("sharp");
const { PDFDocument } = require("pdf-lib");
const { loadConfig } = require("../src/config");
const { createApp, createDeps } = require("../src/app");

// App with no real API keys; pass fakes for openai, http, cloudConvert, browser as needed.
function makeApp(overrides = {}, env = {}) {
  const deps = createDeps(loadConfig(env), overrides);
  return { app: createApp(deps), deps };
}

async function makePdf(pages) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([200, 200]);
  return Buffer.from(await doc.save());
}

async function pageCount(buf) {
  return (await PDFDocument.load(buf)).getPageCount();
}

function makePng(width = 64, height = 48) {
  return sharp({ create: { width, height, channels: 3, background: "#3366ff" } }).png().toBuffer();
}

// Supertest buffers only text/json by default; use this for PDFs, images and zips.
function binary(res, done) {
  const chunks = [];
  res.on("data", (c) => chunks.push(c));
  res.on("end", () => done(null, Buffer.concat(chunks)));
}

const fakeOpenAI = (json) => ({
  chat: { completions: { create: async () => ({ choices: [{ message: { content: JSON.stringify(json) } }] }) } },
});

module.exports = { makeApp, makePdf, pageCount, makePng, binary, fakeOpenAI };
