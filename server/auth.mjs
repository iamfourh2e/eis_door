import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { db } from "./db.mjs";

const scrypt = promisify(scryptCallback);
const cookieName = "doorwatch_session";
const sessionKeyPath = resolve(process.env.SESSION_KEY_PATH || "server-data/session.key");
const sessionHours = Math.max(1, Number.parseInt(process.env.SESSION_HOURS || "12", 10) || 12);
let sessionKey;

function credentials() {
  return {
    username: (process.env.ADMIN_USERNAME || "admin").trim().toLowerCase(),
    password: process.env.ADMIN_PASSWORD || "DoorWatch@123",
  };
}

async function key() {
  if (sessionKey) return sessionKey;
  if (process.env.SESSION_SECRET) {
    sessionKey = Buffer.from(process.env.SESSION_SECRET, "utf8");
    if (sessionKey.length < 32) throw new Error("SESSION_SECRET must contain at least 32 characters");
    return sessionKey;
  }
  try {
    sessionKey = await readFile(sessionKeyPath);
    if (sessionKey.length !== 32) throw new Error("Stored session key is invalid");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    sessionKey = randomBytes(32);
    await mkdir(dirname(sessionKeyPath), { recursive: true });
    await writeFile(sessionKeyPath, sessionKey, { mode: 0o600 });
  }
  return sessionKey;
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = await scrypt(String(password), salt, 64);
  return `scrypt$${salt.toString("base64url")}$${Buffer.from(derived).toString("base64url")}`;
}

export async function verifyPassword(password, stored) {
  const [algorithm, saltValue, hashValue] = String(stored || "").split("$");
  if (algorithm !== "scrypt" || !saltValue || !hashValue) return false;
  const expected = Buffer.from(hashValue, "base64url");
  const actual = Buffer.from(await scrypt(String(password), Buffer.from(saltValue, "base64url"), expected.length));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function provisionDefaultAdmin() {
  const database = db();
  if (!database) throw new Error("MongoDB is not connected");
  const { username, password } = credentials();
  const existing = await database.collection("users").findOne({ username });
  if (existing) return false;
  await database.collection("users").insertOne({
    username,
    displayName: "Administrator",
    role: "admin",
    passwordHash: await hashPassword(password),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return true;
}

function cookieValue(request) {
  const cookies = String(request.headers.cookie || "").split(";");
  for (const cookie of cookies) {
    const [name, ...parts] = cookie.trim().split("=");
    if (name === cookieName) return decodeURIComponent(parts.join("="));
  }
  return "";
}

async function sign(payload) {
  return createHmac("sha256", await key()).update(payload).digest("base64url");
}

async function sessionFor(user) {
  const payload = Buffer.from(JSON.stringify({
    sub: String(user._id),
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    exp: Date.now() + sessionHours * 60 * 60 * 1_000,
  })).toString("base64url");
  return `${payload}.${await sign(payload)}`;
}

export async function readSession(request) {
  const token = cookieValue(request);
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  const expected = await sign(payload);
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!session.exp || session.exp <= Date.now()) return null;
    return session;
  } catch {
    return null;
  }
}

export async function authenticate(username, password) {
  const database = db();
  if (!database) throw new Error("MongoDB is not connected");
  const user = await database.collection("users").findOne({ username: String(username || "").trim().toLowerCase() });
  if (!user || !(await verifyPassword(password, user.passwordHash))) return null;
  return user;
}

export async function setSession(response, user) {
  const token = await sessionFor(user);
  const secure = (process.env.AUTH_COOKIE_SECURE || "false").toLowerCase() === "true";
  response.setHeader("Set-Cookie", `${cookieName}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${sessionHours * 60 * 60}${secure ? "; Secure" : ""}`);
}

export function clearSession(response) {
  response.setHeader("Set-Cookie", `${cookieName}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

export async function requireAuth(request, response, next) {
  const session = await readSession(request);
  if (!session) return response.status(401).json({ error: "Authentication required" });
  request.user = session;
  next();
}
