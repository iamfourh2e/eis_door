import { Agent } from "undici";
import { config } from "./config.mjs";
import { db } from "./db.mjs";
import { broadcast } from "./realtime.mjs";
import { doorTransition, normalizeDoor, normalizeTransaction } from "./normalize.mjs";
import { getZkbioSettings, zkbioSettingsIssue } from "./settings.mjs";
import { enqueueAccessOpenedWebhook } from "./webhooks.mjs";

const state = {
  running: false,
  cycleRunning: false,
  lastPollAt: null,
  lastSuccessAt: null,
  lastError: null,
  lastDurationMs: null,
  transactionsReceived: 0,
  eventsInserted: 0,
  doorsChecked: 0,
  monitorTimestamp: Date.now(),
  configured: false,
  configurationIssue: "ZKBIO_BASE_URL is not configured",
  pollIntervalMs: 10_000,
  centralForwarding: Boolean(config.central.url),
};

let timer;
let backfillTimer;
let forwardTimer;

const insecureDispatcher = new Agent({ connect: { rejectUnauthorized: false } });

function delivery() {
  return config.central.url
    ? { status: "pending", attempts: 0, updatedAt: new Date() }
    : { status: "local_only", attempts: 0, updatedAt: new Date() };
}

async function request(settings, path, params = {}) {
  const url = new URL(`${settings.baseUrl}${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  url.searchParams.set("access_token", settings.accessToken);
  const options = {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(settings.timeoutMs),
  };
  if (settings.allowInsecureTls) options.dispatcher = insecureDispatcher;
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`ZKBio returned HTTP ${response.status}`);
  const payload = await response.json();
  if (Number(payload.code) < 0) throw new Error(payload.message || `ZKBio error ${payload.code}`);
  return payload.data;
}

async function insertEvent(event) {
  const database = db();
  if (!database) return false;
  const result = await database.collection("events").updateOne(
    { sourceKey: event.sourceKey },
    { $setOnInsert: { ...event, delivery: delivery(), createdAt: new Date() } },
    { upsert: true },
  );
  if (result.upsertedCount) {
    state.eventsInserted += 1;
    broadcast("event", { ...event, _id: result.upsertedId });
    return true;
  }
  return false;
}

async function pollTransactions(settings) {
  const records = await request(settings, "/api/transaction/monitor", {
    timestamp: state.monitorTimestamp,
  });
  const list = Array.isArray(records) ? records : [];
  state.transactionsReceived += list.length;
  await Promise.all(
    list.map((raw) => insertEvent(normalizeTransaction(raw, config.collectorId))),
  );
}

async function pollDoors(settings) {
  const records = await request(settings, "/api/door/allDoorState", { timestamp: Date.now() });
  const list = Array.isArray(records) ? records : [];
  state.doorsChecked += list.length;
  const database = db();
  if (!database) return;

  for (const raw of list) {
    const current = normalizeDoor(raw);
    if (!current.doorId) continue;
    const previous = await database.collection("doors").findOne({ doorId: current.doorId });
    const transition = doorTransition(previous, current, config.collectorId);
    await database.collection("doors").updateOne(
      { doorId: current.doorId },
      {
        $set: { ...current, updatedAt: new Date() },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true },
    );
    if (transition?.eventType === "door_opened") {
      const recentScan = await database.collection("events").findOne(
        {
          eventType: "access_granted",
          eventTime: { $gte: new Date(transition.eventTime.getTime() - 20_000), $lte: transition.eventTime },
          $or: [
            { doorName: current.name },
            { eventPointName: current.name },
          ],
        },
        { sort: { eventTime: -1 } },
      );
      if (recentScan) {
        const correlationId = `access-open:${recentScan._id}`;
        transition.correlationId = correlationId;
        transition.relatedEventId = recentScan._id;
        await database.collection("events").updateOne(
          { _id: recentScan._id },
          {
            $set: {
              eventType: "access_granted_opened",
              doorOpenedAt: transition.eventTime,
              sensorState: "open",
              correlationId,
            },
          },
        );
        const correlatedScan = { ...recentScan, eventType: "access_granted_opened", sensorState: "open", correlationId };
        broadcast("event", correlatedScan);
        await enqueueAccessOpenedWebhook(correlatedScan, transition);
      }
    }
    if (transition) await insertEvent(transition);
  }
  broadcast("doors", { updatedAt: new Date() });
}

async function saveCollectorState() {
  const database = db();
  if (!database) return;
  await database.collection("collector_state").updateOne(
    { key: "zkbio" },
    { $set: { ...state, updatedAt: new Date(), collectorId: config.collectorId } },
    { upsert: true },
  );
}

async function cycle() {
  if (state.cycleRunning || !db()) return;
  const settings = await getZkbioSettings();
  const issue = zkbioSettingsIssue(settings);
  state.pollIntervalMs = settings.pollIntervalMs;
  state.configured = !issue;
  state.configurationIssue = issue;
  if (issue) {
    state.lastError = issue;
    await saveCollectorState().catch(() => {});
    broadcast("health", collectorHealth());
    return;
  }
  state.cycleRunning = true;
  state.lastPollAt = new Date();
  const started = Date.now();
  try {
    await pollTransactions(settings);
    await pollDoors(settings);
    state.lastSuccessAt = new Date();
    state.lastError = null;
  } catch (error) {
    state.lastError = error instanceof Error ? error.message : String(error);
  } finally {
    state.lastDurationMs = Date.now() - started;
    state.cycleRunning = false;
    await saveCollectorState().catch(() => {});
    broadcast("health", collectorHealth());
  }
}

async function backfill() {
  if (!db()) return;
  const settings = await getZkbioSettings();
  if (zkbioSettingsIssue(settings)) return;
  const database = db();
  const latest = await database.collection("events").findOne(
    { source: "zkbio", eventTime: { $exists: true } },
    { sort: { eventTime: -1 }, projection: { eventTime: 1 } },
  );
  const start = latest?.eventTime
    ? new Date(latest.eventTime.getTime() - 60_000)
    : new Date(Date.now() - 15 * 60_000);
  const data = await request(settings, "/api/v2/transaction/list", {
    startDate: start.toISOString().slice(0, 19).replace("T", " "),
    endDate: new Date().toISOString().slice(0, 19).replace("T", " "),
    pageNo: 1,
    pageSize: 1000,
  });
  const records = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : [];
  await Promise.all(
    records.map((raw) => insertEvent(normalizeTransaction(raw, config.collectorId))),
  );
}

async function forwardPending() {
  if (!config.central.url || !db()) return;
  const database = db();
  const pending = await database.collection("events")
    .find({ "delivery.status": "pending" })
    .sort({ createdAt: 1 })
    .limit(100)
    .toArray();
  if (!pending.length) return;

  try {
    const response = await fetch(`${config.central.url}/api/ingest/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(config.central.key ? { "x-collector-key": config.central.key } : {}),
      },
      body: JSON.stringify({ collectorId: config.collectorId, events: pending }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Central server returned HTTP ${response.status}`);
    await database.collection("events").updateMany(
      { _id: { $in: pending.map((event) => event._id) } },
      { $set: { "delivery.status": "sent", "delivery.updatedAt": new Date() } },
    );
  } catch (error) {
    await database.collection("events").updateMany(
      { _id: { $in: pending.map((event) => event._id) } },
      {
        $set: {
          "delivery.status": "pending",
          "delivery.lastError": error instanceof Error ? error.message : String(error),
          "delivery.updatedAt": new Date(),
        },
        $inc: { "delivery.attempts": 1 },
      },
    );
  }
}

export function collectorHealth() {
  return { ...state };
}

async function scheduledCycle() {
  await cycle();
  if (state.running) timer = setTimeout(scheduledCycle, state.pollIntervalMs);
}

export function startCollector() {
  if (state.running) return;
  state.running = true;
  scheduledCycle();
  backfillTimer = setInterval(() => backfill().catch(() => {}), 60_000);
  forwardTimer = setInterval(() => forwardPending().catch(() => {}), 10_000);
}

export function stopCollector() {
  clearTimeout(timer);
  clearInterval(backfillTimer);
  clearInterval(forwardTimer);
  state.running = false;
}

export async function testZkbioConnection(settings) {
  const issue = zkbioSettingsIssue(settings);
  if (issue) throw new Error(issue);
  const startedAt = Date.now();
  const doors = await request(settings, "/api/door/allDoorState", { timestamp: Date.now() });
  return {
    ok: true,
    responseTimeMs: Date.now() - startedAt,
    doorCount: Array.isArray(doors) ? doors.length : 0,
  };
}

export function pollNow() {
  if (state.cycleRunning) return;
  clearTimeout(timer);
  scheduledCycle();
}

export async function pollOnce() {
  const deadline = Date.now() + 5_000;
  while (state.cycleRunning && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (state.cycleRunning) throw new Error("Collector is busy; try the simulation again");
  await cycle();
}
