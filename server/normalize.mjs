import { createHash } from "node:crypto";

function text(value) {
  return value == null ? "" : String(value).trim();
}

export function normalizedState(value, fallback = "unknown") {
  const state = text(value).toLowerCase();
  if (!state) return fallback;
  if (state === "none") return "none";
  if (state === "no sensor") return "no_sensor";
  return state.replaceAll(" ", "_");
}

export function parseEventTime(value, fallback = new Date()) {
  if (!value) return fallback;
  const source = text(value);
  const isoLike = source.includes("T") ? source : source.replace(" ", "T");
  const parsed = new Date(isoLike);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

export function classifyTransaction(eventName = "") {
  const name = text(eventName).toLowerCase();
  if (/normal verify open|verification successful|access granted|open successfully/.test(name)) {
    return { eventType: "access_granted", accessResult: "granted", severity: "info" };
  }
  if (/not registered|denied|failed|invalid|expired|anti-passback|forbidden/.test(name)) {
    return { eventType: "access_denied", accessResult: "denied", severity: "warning" };
  }
  if (/duress|tamper|forced|alarm/.test(name)) {
    return { eventType: "access_alarm", accessResult: "alarm", severity: "critical" };
  }
  return { eventType: "access_event", accessResult: "unknown", severity: "info" };
}

function hash(parts) {
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

export function normalizeTransaction(raw, collectorId, receivedAt = new Date()) {
  const classification = classifyTransaction(raw.eventName);
  const eventTime = parseEventTime(raw.eventTime, receivedAt);
  const sourceIdentifier = text(raw.id) || text(raw.logId);
  const sourceKey = sourceIdentifier
    ? `transaction:${text(raw.devSn)}:${sourceIdentifier}`
    : `transaction:${hash([
        text(raw.devSn),
        eventTime.toISOString(),
        text(raw.pin),
        text(raw.cardNo),
        text(raw.readerName),
        text(raw.eventName),
      ])}`;

  return {
    sourceKey,
    source: "zkbio",
    collectorId,
    eventType: classification.eventType,
    accessResult: classification.accessResult,
    severity: classification.severity,
    eventTime,
    receivedAt,
    personPin: text(raw.pin),
    personName: [text(raw.name), text(raw.lastName)].filter(Boolean).join(" "),
    cardNumber: text(raw.cardNo),
    verificationMode: text(raw.verifyModeName),
    deviceSn: text(raw.devSn),
    deviceName: text(raw.devName),
    doorName: text(raw.doorName) || text(raw.eventPointName),
    eventPointName: text(raw.eventPointName),
    readerName: text(raw.readerName),
    areaName: text(raw.areaName),
    eventName: text(raw.eventName),
    eventNo: raw.eventNo ?? null,
    eventLevel: raw.eventLevel ?? null,
    logId: raw.logId ?? null,
    photoBase64: text(raw.capturePhotoBase64),
    rawPayload: raw,
  };
}

export function normalizeDoor(raw, checkedAt = new Date()) {
  return {
    doorId: text(raw.id),
    name: text(raw.name),
    deviceId: text(raw.deviceId),
    connect: normalizedState(raw.connect),
    sensor: normalizedState(raw.sensor),
    relay: normalizedState(raw.relay),
    alarm: normalizedState(raw.alarm, "none"),
    checkedAt,
    rawPayload: raw,
  };
}

export function doorTransition(previous, current, collectorId, occurredAt = new Date()) {
  if (!previous) return null;
  const changed = ["connect", "sensor", "relay", "alarm"].filter(
    (field) => previous[field] !== current[field],
  );
  if (!changed.length) return null;

  let eventType = "door_state_changed";
  let severity = "info";
  if (current.connect !== "1" && current.connect !== "online") {
    eventType = "device_offline";
    severity = "warning";
  }
  if (current.sensor === "open") eventType = "door_opened";
  if (previous.sensor === "open" && current.sensor !== "open") eventType = "door_closed";
  if (current.alarm !== "none" && current.alarm !== "unknown") {
    eventType = "door_alarm";
    severity = "critical";
  }

  return {
    sourceKey: `door:${current.doorId}:${occurredAt.getTime()}:${changed.join(",")}`,
    source: "zkbio",
    collectorId,
    eventType,
    severity,
    eventTime: occurredAt,
    receivedAt: occurredAt,
    doorId: current.doorId,
    doorName: current.name,
    deviceId: current.deviceId,
    sensorState: current.sensor,
    relayState: current.relay,
    alarmState: current.alarm,
    connectionState: current.connect,
    changedFields: changed,
    previousState: Object.fromEntries(changed.map((field) => [field, previous[field]])),
    rawPayload: current.rawPayload,
  };
}

