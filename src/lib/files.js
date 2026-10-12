const fs = require("fs");
const path = require("path");

function safeUnlink(p) {
  try { fs.unlinkSync(p); } catch {}
}

function safeRmDir(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch {}
}

// Streams a file as a download, then deletes it.
function streamFile(res, absPath, filename, contentType) {
  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  const rs = fs.createReadStream(absPath);
  rs.pipe(res);

  const cleanup = () => safeUnlink(absPath);
  rs.on("error", (e) => {
    console.error("stream error:", e);
    if (!res.headersSent) res.status(500).end();
    cleanup();
  });
  rs.on("close", cleanup);
  res.on("close", cleanup);
}

// Finds the newest file in outDir with the target extension whose name contains baseNoExt.
// Only call this on a per-job directory: in a shared directory it can match another user's file.
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

module.exports = { safeUnlink, safeRmDir, streamFile, findConverted };
