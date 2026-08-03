import "dotenv/config";

function integer(name, fallback) {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function cleanUrl(value = "") {
  return value.trim().replace(/\/+$/, "");
}

const pollIntervalMs = Math.max(10_000, integer("ZKBIO_POLL_INTERVAL_MS", 10_000));

export const config = {
  port: integer("API_PORT", 4000),
  mongoUri: process.env.MONGODB_URI?.trim() || "mongodb://127.0.0.1:27017",
  mongoDb: process.env.MONGODB_DB?.trim() || "doorwatch",
  collectorId: process.env.COLLECTOR_ID?.trim() || "doorwatch-local-01",
  zkbio: {
    enabled: (process.env.ZKBIO_ENABLED ?? "true").toLowerCase() !== "false",
    baseUrl: cleanUrl(process.env.ZKBIO_BASE_URL),
    accessToken: process.env.ZKBIO_ACCESS_TOKEN?.trim() || "",
    pollIntervalMs,
    timeoutMs: Math.max(1_000, integer("ZKBIO_REQUEST_TIMEOUT_MS", 8_000)),
    allowInsecureTls:
      (process.env.ZKBIO_ALLOW_INSECURE_TLS ?? "false").toLowerCase() === "true",
  },
  central: {
    url: cleanUrl(process.env.CENTRAL_SERVER_URL),
    key: process.env.CENTRAL_SERVER_KEY?.trim() || "",
  },
};
