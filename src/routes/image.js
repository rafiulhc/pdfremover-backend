const express = require("express");
const fs = require("fs");
const sharp = require("sharp");
const { safeUnlink } = require("../lib/files");

sharp.cache({ files: 0, items: 0, memory: 64 });
sharp.concurrency(2);

const CONTENT_TYPES = { webp: "image/webp", jpeg: "image/jpeg", png: "image/png" };
const EXTENSIONS = { webp: "webp", jpeg: "jpg", png: "png" };

function pickFormat(value, allowed, fallback) {
  let f = String(value || fallback).toLowerCase();
  if (f === "jpg") f = "jpeg";
  return allowed.includes(f) ? f : fallback;
}

// Re-encodes with falling quality, then a shrinking width, until the file fits targetKb.
// PNG stays lossless unless allowLossyIfNoAlpha=true and the image has no transparency.
async function compressToTarget(input, { targetKb, requestedFormat, allowLossyIfNoAlpha, lossyFallback }) {
  const meta = await sharp(input).metadata();
  const hasAlpha = !!meta.hasAlpha;
  const width = meta.width || 2000;
  const targetBytes = targetKb * 1024;

  const MAX_ATTEMPTS = 10;
  const MAX_LOSSY_ATTEMPTS = 6;

  let outBuf = null;
  let lastLen = Infinity;
  let finalFormat = requestedFormat;

  let quality = 82;         // webp/jpeg
  let compressionLevel = 6; // png 0..9
  let colors = 256;         // png palette

  function encodeOnce(fmt, candidateWidth) {
    let pipeline = sharp(input).resize(candidateWidth, null, { fit: "inside", withoutEnlargement: true });
    if (fmt === "webp") pipeline = pipeline.webp({ quality, effort: 4 });
    else if (fmt === "jpeg") pipeline = (hasAlpha ? pipeline.flatten({ background: "#ffffff" }) : pipeline).jpeg({ quality, mozjpeg: true });
    else if (fmt === "png") pipeline = pipeline.png({ compressionLevel: Math.min(9, compressionLevel), palette: true, colors: Math.max(16, colors) });
    return pipeline.toBuffer();
  }

  const widthFor = (shrinkPhase) =>
    shrinkPhase === 0 ? width : Math.max(600, Math.floor(width * Math.pow(0.85, shrinkPhase)));

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    outBuf = await encodeOnce(finalFormat, widthFor(Math.max(0, attempt - 3)));
    if (outBuf.length <= targetBytes) break;
    if (outBuf.length >= lastLen) break;
    lastLen = outBuf.length;

    if (finalFormat === "webp" || finalFormat === "jpeg") {
      quality = Math.max(45, quality - 8);
    } else if (finalFormat === "png") {
      colors = Math.max(16, Math.floor(colors / 2));
      compressionLevel = Math.min(9, compressionLevel + 1);
    }
  }

  if (finalFormat === "png" && allowLossyIfNoAlpha && !hasAlpha && outBuf && outBuf.length > targetBytes) {
    finalFormat = lossyFallback;
    quality = 82; lastLen = Infinity;
    for (let lossyAttempt = 0; lossyAttempt < MAX_LOSSY_ATTEMPTS; lossyAttempt++) {
      const buf = await encodeOnce(finalFormat, widthFor(Math.max(0, lossyAttempt - 2)));
      outBuf = buf;
      if (buf.length <= targetBytes || buf.length >= lastLen) break;
      lastLen = buf.length;
      quality = Math.max(45, quality - 8);
    }
  }

  return { buffer: outBuf || input, format: finalFormat };
}

function imageRouter({ upload }) {
  const router = express.Router();

  router.post("/api/compress/image", upload.single("file"), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const inPath = req.file.path;
    try {
      const { buffer, format } = await compressToTarget(fs.readFileSync(inPath), {
        targetKb: Math.max(50, parseInt(req.body.targetKb || "500", 10)),
        requestedFormat: pickFormat(req.body.format, ["webp", "jpeg", "png"], "webp"),
        allowLossyIfNoAlpha: String(req.body.allowLossyIfNoAlpha || "false").toLowerCase() === "true",
        lossyFallback: pickFormat(req.body.lossyFallback, ["webp", "jpeg"], "webp"),
      });
      res.setHeader("Content-Type", CONTENT_TYPES[format]);
      res.setHeader("Content-Disposition", `attachment; filename="compressed.${EXTENSIONS[format]}"`);
      res.send(buffer);
    } catch (e) {
      console.error("image compress error:", e);
      res.status(500).json({ error: "Failed to compress image" });
    } finally {
      safeUnlink(inPath);
    }
  });

  return router;
}

module.exports = { imageRouter, compressToTarget };
