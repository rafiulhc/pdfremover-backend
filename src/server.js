require("dotenv").config({ quiet: true });

const { loadConfig } = require("./config");
const { createApp, createDeps } = require("./app");
const { setSofficeBin, prewarmLibreOffice } = require("./lib/converters");

const config = loadConfig();
console.log("Resolved soffice path:", setSofficeBin(config.sofficeBin));

const deps = createDeps(config);
const app = createApp(deps);

const server = app.listen(config.port, () =>
  console.log(`Backend running on :${config.port} (web=${config.webConcurrency}, heavy=${config.heavyConcurrency})`));
// Longer than the load balancer's idle timeout, so the LB never reuses a closed socket.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

setInterval(() => {
  deps.tickets.sweep();
  deps.resumeTickets.sweep();
}, 30 * 60 * 1000).unref();

prewarmLibreOffice()
  .then(() => console.log("LibreOffice prewarm done"))
  .catch((e) => console.log("LO prewarm skipped:", e.message));

// Heroku and Kubernetes send SIGTERM before killing the process: stop accepting new
// connections, let in-flight requests finish, then exit.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down`);
  setTimeout(() => process.exit(1), 25_000).unref();
  server.close(async () => {
    await deps.browser.close();
    process.exit(0);
  });
  server.closeIdleConnections();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
