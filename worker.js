// worker.js
const { Worker, QueueEvents, JobsOptions } = require('bullmq');
const { PDFDocument } = require('pdf-lib');
const { spawn } = require('child_process');
const { promises: fsp } = require('fs');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { connection } = require('./queue');

const OUTDIR = path.join(process.cwd(), "uploads");
fs.mkdirSync(OUTDIR, { recursive: true });

function resolveSofficeBin() {
  if (process.env.SOFFICE_BIN) return process.env.SOFFICE_BIN;
  const candidates = ["/usr/bin/libreoffice","/usr/bin/soffice","/usr/lib/libreoffice/program/soffice"];
  for (const p of candidates) { try { if (fs.existsSync(p)) return p; } catch {} }
  return "soffice";
}
const SOFFICE_CMD = resolveSofficeBin();

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

// processors
async function mergeProcessor(data) {
  const { uploadPaths, outName = 'merged.pdf' } = data;
  const mergedPdf = await PDFDocument.create();
  for (const p of uploadPaths) {
    const buf = await fsp.readFile(p);
    const pdf = await PDFDocument.load(buf);
    const copied = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
    copied.forEach((page) => mergedPdf.addPage(page));
  }
  const bytes = await mergedPdf.save();
  // cleanup uploads
  for (const p of uploadPaths) { try { await fsp.unlink(p); } catch {} }

  const outPath = path.join(OUTDIR, `${Date.now()}-${outName}`);
  await fsp.writeFile(outPath, Buffer.from(bytes));
  return { downloadPath: outPath };
}

async function removeProcessor(data) {
  const { uploadPath, removeIndices = [], outName = 'cleaned.pdf' } = data;
  const buf = await fsp.readFile(uploadPath);
  const pdf = await PDFDocument.load(buf);
  const total = pdf.getPageCount();
  const keep = [];
  for (let i = 0; i < total; i++) if (!removeIndices.includes(i)) keep.push(i);

  const outPdf = await PDFDocument.create();
  const copied = await outPdf.copyPages(pdf, keep);
  copied.forEach((p) => outPdf.addPage(p));
  const bytes = await outPdf.save();
  try { await fsp.unlink(uploadPath); } catch {}

  const outPath = path.join(OUTDIR, `${Date.now()}-${outName}`);
  await fsp.writeFile(outPath, Buffer.from(bytes));
  return { downloadPath: outPath };
}

async function docxToPdfProcessor(data) {
  const { uploadPath, origName = "input.docx" } = data;
  const baseNoExt = path.parse(origName).name;
  const outDir = OUTDIR;

  await runSoffice([
    "--headless","--nologo",
    "-env:UserInstallation=file:///tmp/lo_profile",
    "--convert-to","pdf",
    "--outdir", outDir,
    uploadPath
  ]);

  const outFile =
    findConverted(outDir, baseNoExt, "pdf") ||
    findConverted(outDir, path.parse(uploadPath).name, "pdf");

  try { await fsp.unlink(uploadPath); } catch {}

  if (!outFile || !fs.existsSync(outFile)) throw new Error("Conversion output not found");
  const renamed = path.join(OUTDIR, `${Date.now()}-converted.pdf`);
  await fsp.rename(outFile, renamed);
  return { downloadPath: renamed };
}

// worker
const worker = new Worker(
  'pdf-jobs',
  async (job) => {
    switch (job.name) {
      case 'merge':        return await mergeProcessor(job.data);
      case 'remove':       return await removeProcessor(job.data);
      case 'docx-to-pdf':  return await docxToPdfProcessor(job.data);
      default:
        throw new Error(`Unknown job: ${job.name}`);
    }
  },
  {
    // IMPORTANT: concurrency controls memory/CPU spikes on Heroku.
    concurrency: parseInt(process.env.WORKER_CONCURRENCY || "2", 10),
    connection
  }
);

// Optional: auto-cleanup
worker.on('completed', (job) => {
  // job.returnvalue has { downloadPath }
  console.log(`✅ Job ${job.id} done`, job.returnvalue);
});
worker.on('failed', (job, err) => {
  console.error(`❌ Job ${job?.id} failed:`, err?.message);
});

// Queue events (for visibility/logging)
const qe = new QueueEvents('pdf-jobs', { connection });
qe.on('waiting', ({ jobId }) => console.log('waiting', jobId));
qe.on('active', ({ jobId }) => console.log('active', jobId));
qe.on('completed', ({ jobId }) => console.log('completed', jobId));
qe.on('failed', ({ jobId, failedReason }) => console.log('failed', jobId, failedReason));
