import { randomUUID } from "node:crypto";
import { config } from "./config.mjs";
import { db } from "./db.mjs";
import { broadcast } from "./realtime.mjs";
import { getWebhookSettings } from "./settings.mjs";
import { resolveWebhookUrl } from "./webhook-template.mjs";

let workerTimer;

function headers(settings, deliveryId) {
  return {
    "content-type": "application/json",
    "user-agent": "DoorWatch-Webhook/1.0",
    "x-doorwatch-event": "access.granted_opened",
    "x-doorwatch-delivery": deliveryId,
    ...(settings.secret ? { authorization: `Bearer ${settings.secret}` } : {}),
  };
}

export function webhookPayload(scan, doorTransition) {
  return {
    version: "1.0",
    type: "access.granted_opened",
    id: scan.correlationId,
    occurredAt: doorTransition.eventTime,
    collectorId: config.collectorId,
    person: {
      pin: scan.personPin || null,
      name: scan.personName || null,
      cardNumber: scan.cardNumber || null,
    },
    access: {
      result: "granted",
      verificationMode: scan.verificationMode || null,
      eventName: scan.eventName || null,
      scanTime: scan.eventTime,
      readerName: scan.readerName || null,
      areaName: scan.areaName || null,
    },
    door: {
      id: doorTransition.doorId || null,
      name: doorTransition.doorName || scan.doorName || null,
      openedAt: doorTransition.eventTime,
      sensor: doorTransition.sensorState || null,
      relay: doorTransition.relayState || null,
      alarm: doorTransition.alarmState || null,
      connection: doorTransition.connectionState || null,
    },
    device: {
      serialNumber: scan.deviceSn || null,
      name: scan.deviceName || null,
      deviceId: doorTransition.deviceId || null,
    },
    raw: {
      transaction: scan.rawPayload || null,
      doorState: doorTransition.rawPayload || null,
    },
  };
}

export async function enqueueAccessOpenedWebhook(scan, doorTransition) {
  const database = db();
  if (!database) return false;
  const settings = await getWebhookSettings();
  if (!settings.enabled || !settings.url) return false;
  const now = new Date();
  const sourceEventId = String(scan._id);
  const result = await database.collection("webhook_outbox").updateOne(
    { sourceEventId },
    {
      $setOnInsert: {
        deliveryId: randomUUID(),
        sourceEventId,
        correlationId: scan.correlationId,
        eventType: "access.granted_opened",
        payload: webhookPayload(scan, doorTransition),
        status: "pending",
        attempts: 0,
        nextAttemptAt: now,
        createdAt: now,
        updatedAt: now,
      },
    },
    { upsert: true },
  );
  return result.upsertedCount === 1;
}

async function post(settings, deliveryId, payload) {
  const resolvedUrl = resolveWebhookUrl(settings.url, payload);
  const response = await fetch(resolvedUrl, {
    method: "POST",
    headers: headers(settings, deliveryId),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(settings.timeoutMs),
  });
  const responseText = (await response.text()).slice(0, 2_000);
  if (!response.ok) throw new Error(`Webhook returned HTTP ${response.status}${responseText ? `: ${responseText}` : ""}`);
  return { status: response.status, responseText, resolvedUrl };
}

async function deliverPending() {
  const database = db();
  if (!database) return;
  const settings = await getWebhookSettings();
  if (!settings.enabled || !settings.url) return;
  const deliveries = await database.collection("webhook_outbox")
    .find({ status: { $in: ["pending", "retrying"] }, nextAttemptAt: { $lte: new Date() } })
    .sort({ createdAt: 1 })
    .limit(20)
    .toArray();
  for (const delivery of deliveries) {
    try {
      const result = await post(settings, delivery.deliveryId, delivery.payload);
      await database.collection("webhook_outbox").updateOne(
        { _id: delivery._id },
        { $set: { status: "delivered", deliveredAt: new Date(), updatedAt: new Date(), responseStatus: result.status, responseBody: result.responseText, resolvedUrl: result.resolvedUrl, lastError: null } },
      );
      broadcast("webhook", { deliveryId: delivery.deliveryId, status: "delivered" });
    } catch (error) {
      const attempts = delivery.attempts + 1;
      const dead = attempts >= 10;
      const delayMs = Math.min(15 * 60_000, 5_000 * 2 ** Math.min(attempts - 1, 8));
      await database.collection("webhook_outbox").updateOne(
        { _id: delivery._id },
        {
          $set: {
            status: dead ? "failed" : "retrying",
            attempts,
            nextAttemptAt: new Date(Date.now() + delayMs),
            updatedAt: new Date(),
            lastError: error instanceof Error ? error.message : String(error),
          },
        },
      );
      broadcast("webhook", { deliveryId: delivery.deliveryId, status: dead ? "failed" : "retrying" });
    }
  }
}

export async function testWebhook(settings) {
  if (!settings.enabled) return { ok: true, skipped: true, message: "Webhook saved but delivery is disabled" };
  const deliveryId = randomUUID();
  const result = await post(settings, deliveryId, {
    version: "1.0",
    type: "doorwatch.test",
    id: deliveryId,
    occurredAt: new Date(),
    collectorId: config.collectorId,
    person: { pin: "TEST-001", name: "DoorWatch Test", cardNumber: "TEST-CARD" },
    access: { result: "granted", verificationMode: "test", scanTime: new Date() },
    door: { id: "test-door", name: "Test Door", openedAt: new Date(), sensor: "open" },
    device: { serialNumber: "TEST-DEVICE", name: "Test Device" },
    raw: { transaction: null, doorState: null },
    message: "DoorWatch webhook connection test",
  });
  return { ok: true, responseStatus: result.status, resolvedUrl: result.resolvedUrl };
}

export async function webhookStatus() {
  const database = db();
  if (!database) return { pending: 0, retrying: 0, failed: 0, delivered: 0 };
  const rows = await database.collection("webhook_outbox").aggregate([
    { $group: { _id: "$status", count: { $sum: 1 } } },
  ]).toArray();
  return Object.fromEntries(rows.map((row) => [row._id, row.count]));
}

export function startWebhookWorker() {
  if (workerTimer) return;
  deliverPending().catch(() => {});
  workerTimer = setInterval(() => deliverPending().catch(() => {}), 5_000);
}

export function stopWebhookWorker() {
  clearInterval(workerTimer);
  workerTimer = undefined;
}
