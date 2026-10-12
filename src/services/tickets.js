// In-memory ticket store. Works with ONE process only: behind a load balancer each
// replica has its own Map. Stage 2 replaces this with Redis behind the same interface.
const { randomUUID } = require("crypto");

function newTicket() {
  return randomUUID().replace(/-/g, "");
}

function createTicketStore({ ttlMs }) {
  const map = new Map();
  return {
    get: (ticket) => map.get(ticket),
    set: (ticket, rec) => { map.set(ticket, rec); },
    get size() { return map.size; },
    sweep(now = Date.now()) {
      for (const [t, rec] of map) if (now - rec.createdAt > ttlMs) map.delete(t);
    },
  };
}

module.exports = { newTicket, createTicketStore };
