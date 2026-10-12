const express = require("express");

// Liveness check for Heroku / load balancers / Kubernetes probes. Cheap on purpose:
// it must not call LibreOffice, OpenAI or anything else that can be slow.
function healthRouter() {
  const router = express.Router();
  router.get("/health", (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({ status: "ok" });
  });
  return router;
}

module.exports = { healthRouter };
