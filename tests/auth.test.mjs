import assert from "node:assert/strict";
import test from "node:test";
import { hashPassword, verifyPassword } from "../server/auth.mjs";

test("hashes and verifies administrator passwords", async () => {
  const stored = await hashPassword("DoorWatch@123");
  assert.notEqual(stored, "DoorWatch@123");
  assert.equal(await verifyPassword("DoorWatch@123", stored), true);
  assert.equal(await verifyPassword("wrong-password", stored), false);
});
