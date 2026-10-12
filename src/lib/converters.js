// Wrappers around the external binaries: LibreOffice, Ghostscript, Poppler.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { safeRmDir } = require("./files");

function resolveSofficeBin(override) {
  if (override) return override;
  const candidates = ["/usr/bin/libreoffice", "/usr/bin/soffice", "/usr/lib/libreoffice/program/soffice"];
  for (const p of candidates) { try { if (fs.existsSync(p)) return p; } catch {} }
  return "soffice";
}

let sofficeCmd = resolveSofficeBin(process.env.SOFFICE_BIN);

function setSofficeBin(bin) {
  sofficeCmd = resolveSofficeBin(bin);
  return sofficeCmd;
}

// `infilter` picks the import filter, e.g. "writer_pdf_import": by default LibreOffice
// opens PDFs in Draw, which cannot export .docx.
function sofficeConvertArgs(format, outDir, inputPath, { infilter } = {}) {
  return [
    "--headless", "--nologo",
    "-env:UserInstallation=file:///tmp/lo_profile",
    ...(infilter ? [`--infilter=${infilter}`] : []),
    "--convert-to", format,
    "--outdir", outDir,
    inputPath,
  ];
}

function runSoffice(args, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(sofficeCmd, args, { env: { ...process.env, HOME: process.env.HOME || "/tmp" } });
    let stderr = "", stdout = "";
    const to = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} ; reject(new Error(`LibreOffice timeout after ${timeoutMs}ms`)); }, timeoutMs);
    child.stdout.on("data", d => (stdout += d.toString()));
    child.stderr.on("data", d => (stderr += d.toString()));
    child.on("error", err => { clearTimeout(to); reject(new Error(`Failed to start soffice (${sofficeCmd}): ${err.message}`)); });
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
      "-dNOPAUSE", "-dQUIET", "-dBATCH",
      "-dDetectDuplicateImages=true",
      "-dCompressFonts=true",
      "-dSubsetFonts=true",
      "-dDownsampleColorImages=true", `-dColorImageResolution=${colorRes}`,
      "-dDownsampleGrayImages=true",  `-dGrayImageResolution=${grayRes}`,
      "-dDownsampleMonoImages=true",  `-dMonoImageResolution=${monoRes}`,
      "-dNumRenderingThreads=2",
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

function runPdftoppm(pdfPath, prefix) {
  return new Promise((resolve, reject) => {
    const p = spawn("pdftoppm", ["-png", "-rx", "144", "-ry", "144", pdfPath, prefix]);
    let err = "";
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err || `pdftoppm exited ${code}`))));
    p.on("error", reject);
  });
}

// First LibreOffice start is slow; do it at boot instead of on a user's request.
async function prewarmLibreOffice() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "warm-"));
  try {
    const f = path.join(d, "x.txt");
    fs.writeFileSync(f, "warm");
    await runSoffice(sofficeConvertArgs("pdf", d, f));
  } finally {
    safeRmDir(d);
  }
}

module.exports = {
  setSofficeBin, sofficeConvertArgs, runSoffice, runGhostscript, runPdftoppm, prewarmLibreOffice,
};
