import cors from "cors";
import express from "express";
import { ObjectId } from "mongodb";
import { collectorHealth, pollNow, pollOnce, startCollector, stopCollector, testZkbioConnection } from "./collector.mjs";
import { config } from "./config.mjs";
import { closeMongo, connectMongo, db, mongoHealth } from "./db.mjs";
import { broadcast, liveClientCount, subscribe } from "./realtime.mjs";
import { getPublicWebhookSettings, getPublicZkbioSettings, getZkbioSettings, saveWebhookSettings, saveZkbioSettings } from "./settings.mjs";
import { simulatorConfiguration, simulatorRequest } from "./simulator.mjs";
import { startWebhookWorker, stopWebhookWorker, testWebhook, webhookStatus } from "./webhooks.mjs";

const app = express();
app.disable("x-powered-by");
app.use(cors({ origin: true, credentials: false }));
app.use(express.json({ limit: "2mb" }));

function serialize(value) {
  return JSON.parse(JSON.stringify(value));
}

app.get("/api/health", (_request, response) => {
  response.json({
    ok: true,
    mongo: mongoHealth(),
    collector: collectorHealth(),
    liveClients: liveClientCount(),
    serverTime: new Date(),
  });
});

app.get("/api/live", (request, response) => {
  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache");
  response.setHeader("Connection", "keep-alive");
  response.flushHeaders();
  const unsubscribe = subscribe(response);
  const keepAlive = setInterval(() => response.write(": keepalive\n\n"), 20_000);
  request.on("close", () => {
    clearInterval(keepAlive);
    unsubscribe();
  });
});

app.get("/api/dashboard", async (_request, response) => {
  const database = db();
  if (!database) return response.status(503).json({ error: "MongoDB is not connected" });
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const [totalDoors, onlineDoors, openDoors, activeAlerts, scansToday, deniedToday, pendingUploads] =
    await Promise.all([
      database.collection("doors").countDocuments(),
      database.collection("doors").countDocuments({ connect: { $in: ["1", "online"] } }),
      database.collection("doors").countDocuments({ sensor: "open" }),
      database.collection("doors").countDocuments({
        $or: [
          { connect: { $nin: ["1", "online"] } },
          { alarm: { $nin: ["none", "unknown", ""] } },
        ],
      }),
      database.collection("events").countDocuments({
        eventTime: { $gte: today },
        eventType: { $in: ["access_granted", "access_granted_opened", "access_denied", "access_alarm", "access_event"] },
      }),
      database.collection("events").countDocuments({ eventTime: { $gte: today }, accessResult: "denied" }),
      database.collection("events").countDocuments({ "delivery.status": "pending" }),
    ]);
  response.json({ totalDoors, onlineDoors, openDoors, activeAlerts, scansToday, deniedToday, pendingUploads });
});

app.get("/api/events", async (request, response) => {
  const database = db();
  if (!database) return response.status(503).json({ error: "MongoDB is not connected" });
  const limit = Math.min(200, Math.max(1, Number.parseInt(String(request.query.limit ?? 50), 10) || 50));
  const filter = {};
  if (request.query.result) filter.accessResult = request.query.result;
  if (request.query.door) filter.doorName = request.query.door;
  const events = await database.collection("events")
    .find(filter, { projection: { photoBase64: 0 } })
    .sort({ eventTime: -1 })
    .limit(limit)
    .toArray();
  response.json(serialize(events));
});

app.get("/api/events/:id", async (request, response) => {
  const database = db();
  if (!database) return response.status(503).json({ error: "MongoDB is not connected" });
  if (!ObjectId.isValid(request.params.id)) return response.status(400).json({ error: "Invalid event id" });
  const event = await database.collection("events").findOne({ _id: new ObjectId(request.params.id) });
  if (!event) return response.status(404).json({ error: "Event not found" });
  response.json(serialize(event));
});

app.get("/api/doors", async (_request, response) => {
  const database = db();
  if (!database) return response.status(503).json({ error: "MongoDB is not connected" });
  const doors = await database.collection("doors").find().sort({ name: 1 }).toArray();
  response.json(serialize(doors));
});

app.get("/api/settings/zkbio", async (_request, response) => {
  if (!db()) return response.status(503).json({ error: "MongoDB is not connected" });
  response.json(await getPublicZkbioSettings());
});

app.put("/api/settings/zkbio", async (request, response) => {
  if (!db()) return response.status(503).json({ error: "MongoDB is not connected" });
  const saved = await saveZkbioSettings(request.body ?? {});
  let connectionTest;
  try {
    connectionTest = await testZkbioConnection(saved);
  } catch (error) {
    connectionTest = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  pollNow();
  response.json({ settings: await getPublicZkbioSettings(), connectionTest });
});

app.get("/api/simulator", async (_request, response) => {
  const configuration = simulatorConfiguration();
  if (!configuration.available) return response.json({ available: false });
  const status = await simulatorRequest("status");
  response.json({ available: true, baseUrl: configuration.baseUrl, ...status });
});

app.post("/api/simulator/connect", async (_request, response) => {
  const configuration = simulatorConfiguration();
  if (!configuration.available) return response.status(503).json({ error: "ZKBio simulator is not available" });
  const saved = await saveZkbioSettings({
    enabled: true,
    baseUrl: configuration.baseUrl,
    accessToken: configuration.accessToken,
    pollIntervalMs: 10_000,
    timeoutMs: 8_000,
    allowInsecureTls: false,
  });
  const connectionTest = await testZkbioConnection(saved);
  await simulatorRequest("door/close", {});
  await pollOnce();
  response.json({ ok: true, settings: await getPublicZkbioSettings(), connectionTest, simulator: await simulatorRequest("status") });
});

async function requireSimulatorConnection() {
  const configuration = simulatorConfiguration();
  const settings = await getZkbioSettings();
  if (!configuration.available || settings.baseUrl !== configuration.baseUrl) {
    throw new Error("Connect the ZKBio simulator first");
  }
}

app.post("/api/simulator/access", async (request, response) => {
  await requireSimulatorConnection();
  await simulatorRequest("door/close", {});
  await pollOnce();
  const scan = await simulatorRequest("scan/granted", request.body ?? {});
  await pollOnce();
  await simulatorRequest("door/open", {});
  await pollOnce();
  response.json({ ok: true, scan: scan.transaction, simulator: await simulatorRequest("status") });
});

app.post("/api/simulator/denied", async (request, response) => {
  await requireSimulatorConnection();
  const scan = await simulatorRequest("scan/denied", request.body ?? {});
  await pollOnce();
  response.json({ ok: true, scan: scan.transaction, simulator: await simulatorRequest("status") });
});

app.post("/api/simulator/close", async (_request, response) => {
  await requireSimulatorConnection();
  await simulatorRequest("door/close", {});
  await pollOnce();
  response.json({ ok: true, simulator: await simulatorRequest("status") });
});

app.get("/api/settings/webhook", async (_request, response) => {
  if (!db()) return response.status(503).json({ error: "MongoDB is not connected" });
  response.json({ settings: await getPublicWebhookSettings(), status: await webhookStatus() });
});

app.put("/api/settings/webhook", async (request, response) => {
  if (!db()) return response.status(503).json({ error: "MongoDB is not connected" });
  const saved = await saveWebhookSettings(request.body ?? {});
  let connectionTest;
  try {
    connectionTest = await testWebhook(saved);
  } catch (error) {
    connectionTest = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  response.json({ settings: await getPublicWebhookSettings(), connectionTest, status: await webhookStatus() });
});

app.post("/api/ingest/events", async (request, response) => {
  if (config.central.key && request.header("x-collector-key") !== config.central.key) {
    return response.status(401).json({ error: "Invalid collector key" });
  }
  const database = db();
  if (!database) return response.status(503).json({ error: "MongoDB is not connected" });
  const events = Array.isArray(request.body?.events) ? request.body.events.slice(0, 500) : [];
  let accepted = 0;
  for (const incoming of events) {
    if (!incoming?.sourceKey) continue;
    const event = { ...incoming };
    delete event._id;
    const result = await database.collection("events").updateOne(
      { sourceKey: event.sourceKey },
      {
        $setOnInsert: {
          ...event,
          collectorId: request.body.collectorId || event.collectorId,
          delivery: { status: "received", attempts: 0, updatedAt: new Date() },
          createdAt: new Date(),
        },
      },
      { upsert: true },
    );
    accepted += result.upsertedCount;
  }
  if (accepted) broadcast("events", { accepted });
  response.json({ accepted, received: events.length });
});

app.use((error, _request, response, _next) => {
  void _next;
  response.status(500).json({ error: error instanceof Error ? error.message : "Unexpected server error" });
});

const server = app.listen(config.port, "0.0.0.0", () => {
  console.log(`DoorWatch API listening on http://localhost:${config.port}`);
});

async function connectWithRetry() {
  try {
    await connectMongo();
    console.log(`Connected to MongoDB database ${config.mongoDb}`);
    startCollector();
    startWebhookWorker();
  } catch (error) {
    console.error(`MongoDB connection failed: ${error instanceof Error ? error.message : error}`);
    setTimeout(connectWithRetry, 5_000);
  }
}

connectWithRetry();

async function shutdown() {
  stopCollector();
  stopWebhookWorker();
  server.close();
  await closeMongo();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
