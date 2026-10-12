// Gumroad "ping" webhook: marks a resume or pro ticket as paid.
const express = require("express");
const { extractTicket } = require("../services/gumroad");

function gumroadRouter({ tickets, resumeTickets }) {
  const router = express.Router();

  router.post("/api/gumroad/ping", (req, res) => {
    const body = req.body || {};
    const slug = (body.product_permalink || "").split("/").pop();

    // Accept PPP: any positive amount
    const cents = parseInt(body.price || "0", 10);
    if (!Number.isFinite(cents) || cents < 1) {
      console.log("PING: no/zero price", { cents });
      return res.status(400).send("No payment amount");
    }

    if (String(body.refunded || "").toLowerCase() === "true") {
      console.log("PING: refunded");
      return res.status(200).send("Ignored (refunded)");
    }

    const ticket = extractTicket(body);
    console.log("PING incoming", {
      product: slug,
      ticket,
      ticketsSize: tickets.size,
      resumeTicketsSize: resumeTickets.size
    });

    if (!ticket) {
      console.log("PING: missing ticket entirely");
      return res.status(200).send("No matching ticket");
    }

    // Try resume first, then pro
    for (const [store, kind] of [[resumeTickets, "RESUME"], [tickets, "PDFPRO"]]) {
      const rec = store.get(ticket);
      if (rec) {
        rec.paid = true;
        console.log(`PING: OK (paid) ${kind}`, { ticket, cents, product: slug });
        return res.status(200).send("OK");
      }
    }

    console.log("PING: no matching ticket", { ticket, product: slug });
    res.status(200).send("No matching ticket");
  });

  return router;
}

module.exports = { gumroadRouter };
