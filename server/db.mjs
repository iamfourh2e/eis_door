import { MongoClient } from "mongodb";
import { config } from "./config.mjs";

let client;
let database;
let connecting;
let lastError = null;
let connectedAt = null;

async function ensureIndexes(db) {
  await Promise.all([
    db.collection("events").createIndex({ sourceKey: 1 }, { unique: true }),
    db.collection("events").createIndex({ eventTime: -1 }),
    db.collection("events").createIndex({ doorName: 1, eventTime: -1 }),
    db.collection("events").createIndex({ "delivery.status": 1, createdAt: 1 }),
    db.collection("doors").createIndex({ doorId: 1 }, { unique: true }),
    db.collection("doors").createIndex({ connect: 1, sensor: 1, alarm: 1 }),
    db.collection("collector_state").createIndex({ key: 1 }, { unique: true }),
    db.collection("settings").createIndex({ key: 1 }, { unique: true }),
    db.collection("webhook_outbox").createIndex({ sourceEventId: 1 }, { unique: true }),
    db.collection("webhook_outbox").createIndex({ status: 1, nextAttemptAt: 1 }),
    db.collection("webhook_outbox").createIndex({ createdAt: -1 }),
  ]);
}

export async function connectMongo() {
  if (database) return database;
  if (connecting) return connecting;

  connecting = (async () => {
    try {
      client = new MongoClient(config.mongoUri, {
        serverSelectionTimeoutMS: 3_000,
        connectTimeoutMS: 3_000,
      });
      await client.connect();
      database = client.db(config.mongoDb);
      await ensureIndexes(database);
      lastError = null;
      connectedAt = new Date();
      return database;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      database = undefined;
      await client?.close().catch(() => {});
      client = undefined;
      throw error;
    } finally {
      connecting = undefined;
    }
  })();

  return connecting;
}

export function db() {
  return database;
}

export function mongoHealth() {
  return {
    connected: Boolean(database),
    connectedAt,
    error: lastError,
    database: config.mongoDb,
  };
}

export async function closeMongo() {
  await client?.close();
  client = undefined;
  database = undefined;
}
