import assert from "node:assert/strict";
import test from "node:test";
import { webhookPayload } from "../server/webhooks.mjs";
import { resolveWebhookUrl, validateWebhookTemplate } from "../server/webhook-template.mjs";

test("builds the completed access webhook payload", () => {
  const payload = webhookPayload(
    {
      correlationId: "access-open:abc",
      personPin: "57",
      personName: "Sok Dara",
      cardNumber: "9606650",
      verificationMode: "Face",
      eventName: "Normal Verify Open",
      eventTime: new Date("2026-08-03T01:41:12Z"),
      readerName: "Main-In",
      doorName: "Main entrance",
      deviceSn: "7633223440032",
      rawPayload: { logId: 161 },
    },
    {
      doorId: "door-1",
      doorName: "Main entrance",
      deviceId: "device-1",
      eventTime: new Date("2026-08-03T01:41:14Z"),
      sensorState: "open",
      relayState: "open",
      alarmState: "none",
      connectionState: "1",
      rawPayload: { sensor: "open" },
    },
  );
  assert.equal(payload.type, "access.granted_opened");
  assert.equal(payload.person.pin, "57");
  assert.equal(payload.door.sensor, "open");
  assert.equal(payload.device.serialNumber, "7633223440032");
  assert.deepEqual(payload.raw.transaction, { logId: 161 });
});

test("resolves and URL-encodes webhook destination fields", () => {
  const url = resolveWebhookUrl(
    "https://example.com/events/{{person.pin}}?door={{door.id}}",
    { person: { pin: "A 57" }, door: { id: "front/1" } },
  );
  assert.equal(url, "https://example.com/events/A%2057?door=front%2F1");
});

test("rejects unsupported, missing, and host placeholders", () => {
  assert.throws(() => validateWebhookTemplate("https://example.com/{{person.name}}"), /Unsupported webhook URL field/);
  assert.throws(() => resolveWebhookUrl("https://example.com/{{person.pin}}", { person: {} }), /is missing/);
  assert.throws(() => validateWebhookTemplate("https://{{door.id}}.example.com/events"), /allowed only/);
});
