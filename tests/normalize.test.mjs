import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyTransaction,
  doorTransition,
  normalizeDoor,
  normalizeTransaction,
  normalizedState,
} from "../server/normalize.mjs";

test("normalizes inconsistent ZKBio door state casing", () => {
  assert.equal(normalizedState("None"), "none");
  assert.equal(normalizedState("No sensor"), "no_sensor");
  assert.equal(normalizedState("BE OPENED ACCIDENTALLY"), "be_opened_accidentally");
});

test("classifies granted and denied transactions", () => {
  assert.deepEqual(classifyTransaction("Normal Verify Open"), {
    eventType: "access_granted",
    accessResult: "granted",
    severity: "info",
  });
  assert.equal(classifyTransaction("card is not registered").accessResult, "denied");
});

test("uses the device log id as a stable transaction key", () => {
  const event = normalizeTransaction(
    {
      eventTime: "2026-08-03 08:41:12",
      devSn: "7633223440032",
      logId: 161,
      eventName: "Normal Verify Open",
      pin: "57",
    },
    "test-collector",
  );
  assert.equal(event.sourceKey, "transaction:7633223440032:161");
  assert.equal(event.accessResult, "granted");
});

test("creates a physical door-open transition event", () => {
  const previous = normalizeDoor({ id: "door-1", name: "Main", connect: "1", sensor: "off", relay: "off", alarm: "None" });
  const current = normalizeDoor({ id: "door-1", name: "Main", connect: "1", sensor: "open", relay: "open", alarm: "none" });
  const event = doorTransition(previous, current, "test-collector", new Date("2026-08-03T01:41:14Z"));
  assert.equal(event.eventType, "door_opened");
  assert.deepEqual(event.changedFields, ["sensor", "relay"]);
});

