// All environment variables are read here, once, so the rest of the code
// never touches process.env directly.

const DEFAULT_CORS_ORIGINS = [
  "http://localhost:3000",
  "https://pdfremover-frontend.vercel.app",
  "https://pdfmergersplitter.app",
  "https://www.pdfmergersplitter.app",
];

function int(value, fallback) {
  const n = parseInt(value ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
}

function list(value, fallback) {
  if (!value) return fallback;
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

function loadConfig(env = process.env) {
  return {
    port: int(env.PORT, 4000),
    // pdf->docx, docx->pdf, pdf compress, pdf->images run at most this many at once
    heavyConcurrency: int(env.HEAVY_CONCURRENCY, 2),
    webConcurrency: int(env.WEB_CONCURRENCY, 2),
    corsOrigins: list(env.CORS_ORIGINS, DEFAULT_CORS_ORIGINS),
    uploadMaxBytes: int(env.UPLOAD_MAX_MB, 32) * 1024 * 1024,
    uploadMaxFiles: int(env.UPLOAD_MAX_FILES, 20),
    ticketTtlMs: 2 * 60 * 60 * 1000,

    openaiApiKey: env.OPENAI_API_KEY || "",
    openaiModel: env.OPENAI_MODEL || "gpt-4o",
    cloudConvertApiKey: env.CLOUDCONVERT_API_KEY || "",
    gumroadAccessToken: env.GUMROAD_ACCESS_TOKEN || "",
    gumroadProductPermalink: env.GUMROAD_PRODUCT_PERMALINK || "ubtedo",
    gumroadResumePermalink: env.GUMROAD_PRODUCT_PERMALINK_RESUME || "nktxk",

    sofficeBin: env.SOFFICE_BIN || "",
    chromiumPath: env.PUPPETEER_EXECUTABLE_PATH || "",
  };
}

module.exports = { loadConfig };
