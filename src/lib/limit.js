// Minimal p-limit: run at most `concurrency` jobs at once, queue the rest.
function createLimit(concurrency) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= concurrency) return;
    const job = queue.shift();
    if (!job) return;
    active++;
    Promise.resolve()
      .then(job.fn)
      .then((v) => { active--; job.resolve(v); next(); })
      .catch((e) => { active--; job.reject(e); next(); });
  };
  return (fn) => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject }); next();
  });
}

// Wraps an Express handler so it runs inside the limit.
function createHeavyWrapper(concurrency) {
  const limit = createLimit(concurrency);
  return (handler) => (req, res) =>
    limit(() => handler(req, res)).catch((err) => {
      console.error(err);
      if (!res.headersSent) res.status(500).json({ error: "Processing failed" });
    });
}

module.exports = { createLimit, createHeavyWrapper };
