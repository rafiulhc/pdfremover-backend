function buyUrl(permalink, ticket, { ticketField = false } = {}) {
  const t = encodeURIComponent(ticket);
  const base = `https://gumroad.com/l/${encodeURIComponent(permalink)}?wanted=true&ticket=${t}`;
  return ticketField ? `${base}&fields[ticket]=${t}` : base;
}

// Fallback when the Gumroad ping is lost: ask the Sales API whether this ticket was paid.
async function reconcilePayment({ http, accessToken, permalink, ticket, now = Date.now() }) {
  try {
    if (!accessToken) return false;
    const since = new Date(now - 2 * 60 * 60 * 1000).toISOString();
    const url = `https://api.gumroad.com/v2/sales?access_token=${encodeURIComponent(accessToken)}&product_permalink=${encodeURIComponent(permalink)}&after=${encodeURIComponent(since)}`;
    const { data } = await http.get(url);
    const sales = data?.sales || [];
    for (const s of sales) {
      const params = s.url_params || {};
      const saleTicket = params.ticket || params.TICKET;
      const refunded = String(s.refunded || "").toLowerCase() === "true";
      if (!refunded && saleTicket === ticket) return true;
    }
  } catch (e) { console.warn("reconcilePayment error:", e.message); }
  return false;
}

// Gumroad sends the ticket in different places depending on how the buy link was built.
function extractTicket(body) {
  const { url_params, custom_fields } = body;
  let ticket;
  if (url_params) {
    if (typeof url_params === "string") {
      try { ticket = JSON.parse(url_params).ticket; } catch {}
    } else if (typeof url_params === "object") {
      ticket = url_params.ticket || url_params.TICKET;
    }
  }
  if (!ticket && custom_fields && typeof custom_fields === "object") {
    ticket = custom_fields.ticket || custom_fields.TICKET;
  }
  if (!ticket && typeof body["fields[ticket]"] === "string") {
    ticket = body["fields[ticket]"];
  }
  if (!ticket && typeof body.ticket === "string") {
    ticket = body.ticket;
  }
  return ticket;
}

module.exports = { buyUrl, reconcilePayment, extractTicket };
