import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { config } from "./config.mjs";
import { db } from "./db.mjs";
import { validateWebhookTemplate } from "./webhook-template.mjs";

const keyPath = resolve(process.env.CONFIG_KEY_PATH || "server-data/config.key");
let encryptionKey;

async function getEncryptionKey() {
  if (encryptionKey) return encryptionKey;
  if (process.env.CONFIG_ENCRYPTION_KEY) {
    const supplied = Buffer.from(process.env.CONFIG_ENCRYPTION_KEY, "base64");
    if (supplied.length !== 32) throw new Error("CONFIG_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
    encryptionKey = supplied;
    return encryptionKey;
  }
  try {
    const stored = await readFile(keyPath);
    if (stored.length !== 32) throw new Error("Stored configuration key is invalid");
    encryptionKey = stored;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    encryptionKey = randomBytes(32);
    await mkdir(dirname(keyPath), { recursive: true });
    await writeFile(keyPath, encryptionKey, { mode: 0o600 });
  }
  return encryptionKey;
}

async function encrypt(secret) {
  const key = await getEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map((part) => part.toString("base64")).join(".");
}

async function decrypt(payload) {
  if (!payload) return "";
  const key = await getEncryptionKey();
  const [iv, tag, encrypted] = payload.split(".").map((part) => Buffer.from(part, "base64"));
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

function cleanUrl(value = "") {
  return String(value).trim().replace(/\/+$/, "");
}

function safeInterval(value) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? Math.min(60_000, Math.max(10_000, parsed)) : 10_000;
}

function safeTimeout(value) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? Math.min(30_000, Math.max(1_000, parsed)) : 8_000;
}

export function zkbioSettingsIssue(settings) {
  if (!settings.enabled) return "Collector disabled in Settings";
  if (!settings.baseUrl) return "ZKBIO_BASE_URL is not configured";
  if (!settings.accessToken) return "ZKBIO access token is not configured";
  return null;
}

export async function getZkbioSettings() {
  const database = db();
  const saved = database
    ? await database.collection("settings").findOne({ key: "zkbio" })
    : null;
  let accessToken = config.zkbio.accessToken;
  if (saved?.accessTokenEncrypted) accessToken = await decrypt(saved.accessTokenEncrypted);
  return {
    enabled: saved?.enabled ?? config.zkbio.enabled,
    baseUrl: cleanUrl(saved?.baseUrl ?? config.zkbio.baseUrl),
    accessToken,
    pollIntervalMs: safeInterval(saved?.pollIntervalMs ?? config.zkbio.pollIntervalMs),
    timeoutMs: safeTimeout(saved?.timeoutMs ?? config.zkbio.timeoutMs),
    allowInsecureTls: saved?.allowInsecureTls ?? config.zkbio.allowInsecureTls,
    updatedAt: saved?.updatedAt ?? null,
  };
}

export async function getPublicZkbioSettings() {
  const settings = await getZkbioSettings();
  return {
    enabled: settings.enabled,
    baseUrl: settings.baseUrl,
    accessTokenConfigured: Boolean(settings.accessToken),
    pollIntervalMs: settings.pollIntervalMs,
    timeoutMs: settings.timeoutMs,
    allowInsecureTls: settings.allowInsecureTls,
    updatedAt: settings.updatedAt,
  };
}

export async function saveZkbioSettings(input) {
  const database = db();
  if (!database) throw new Error("MongoDB is not connected");
  const current = await database.collection("settings").findOne({ key: "zkbio" });
  const update = {
    key: "zkbio",
    enabled: input.enabled !== false,
    baseUrl: cleanUrl(input.baseUrl),
    pollIntervalMs: safeInterval(input.pollIntervalMs),
    timeoutMs: safeTimeout(input.timeoutMs),
    allowInsecureTls: input.allowInsecureTls === true,
    updatedAt: new Date(),
  };
  if (typeof input.accessToken === "string" && input.accessToken.trim()) {
    update.accessTokenEncrypted = await encrypt(input.accessToken.trim());
  } else if (current?.accessTokenEncrypted) {
    update.accessTokenEncrypted = current.accessTokenEncrypted;
  }
  await database.collection("settings").updateOne(
    { key: "zkbio" },
    { $set: update, $setOnInsert: { createdAt: new Date() } },
    { upsert: true },
  );
  return getZkbioSettings();
}

function validWebhookUrl(value) {
  return validateWebhookTemplate(value);
}

export async function getWebhookSettings() {
  const database = db();
  const saved = database
    ? await database.collection("settings").findOne({ key: "webhook" })
    : null;
  return {
    enabled: saved?.enabled ?? false,
    url: saved?.url ?? "",
    secret: saved?.secretEncrypted ? await decrypt(saved.secretEncrypted) : "",
    timeoutMs: safeTimeout(saved?.timeoutMs ?? 8_000),
    updatedAt: saved?.updatedAt ?? null,
  };
}

export async function getPublicWebhookSettings() {
  const settings = await getWebhookSettings();
  return {
    enabled: settings.enabled,
    url: settings.url,
    secretConfigured: Boolean(settings.secret),
    timeoutMs: settings.timeoutMs,
    eventType: "access.granted_opened",
    updatedAt: settings.updatedAt,
  };
}

export async function saveWebhookSettings(input) {
  const database = db();
  if (!database) throw new Error("MongoDB is not connected");
  const current = await database.collection("settings").findOne({ key: "webhook" });
  const update = {
    key: "webhook",
    enabled: input.enabled === true,
    url: validWebhookUrl(input.url),
    timeoutMs: safeTimeout(input.timeoutMs),
    updatedAt: new Date(),
  };
  if (typeof input.secret === "string" && input.secret.trim()) {
    update.secretEncrypted = await encrypt(input.secret.trim());
  } else if (current?.secretEncrypted) {
    update.secretEncrypted = current.secretEncrypted;
  }
  if (update.enabled && !update.url) throw new Error("Webhook URL is required when delivery is enabled");
  await database.collection("settings").updateOne(
    { key: "webhook" },
    { $set: update, $setOnInsert: { createdAt: new Date() } },
    { upsert: true },
  );
  return getWebhookSettings();
}
