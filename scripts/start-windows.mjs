import "dotenv/config";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import { resolve } from "node:path";

const rootDir = process.cwd();
const vinextCli = resolve(rootDir, "node_modules/vinext/dist/cli.js");
const args = new Set(process.argv.slice(2));

const isDev = args.has("--dev");
const forceRebuild = args.has("--rebuild");
const waitMongo = args.has("--wait-mongo");
const withSimulator =
  args.has("--with-simulator") ||
  (process.env.START_ZKBIO_SIMULATOR ?? "false").toLowerCase() === "true";

const webPort = String(Number.parseInt(process.env.DOORWATCH_WEB_PORT || "3080", 10) || 3080);
const apiPort = String(Number.parseInt(process.env.API_PORT || "4000", 10) || 4000);
const mockPort = String(Number.parseInt(process.env.MOCK_ZKBIO_PORT || "8090", 10) || 8090);
const mockToken = process.env.MOCK_ZKBIO_TOKEN || "demo-token";
const mongoUri = process.env.MONGODB_URI?.trim() || "mongodb://127.0.0.1:27017";

function checkNodeVersion() {
  const [major, minor] = process.versions.node.split(".").map((n) => Number.parseInt(n, 10));
  if (major < 22 || (major === 22 && minor < 13)) {
    console.error(`[doorwatch] Node.js >= 22.13.0 is required (found ${process.versions.node}).`);
    process.exit(1);
  }
}

function parseMongoHostPort(uri) {
  try {
    const normalized = uri.replace(/^mongodb(\+srv)?:\/\//, "http://");
    const url = new URL(normalized);
    return {
      host: url.hostname || "127.0.0.1",
      port: Number.parseInt(url.port || "27017", 10) || 27017,
      isSrv: uri.startsWith("mongodb+srv://"),
    };
  } catch {
    return { host: "127.0.0.1", port: 27017, isSrv: false };
  }
}

function checkTcpPort(host, port, timeoutMs = 2000) {
  return new Promise((resolvePromise) => {
    const socket = net.createConnection({ host, port });
    const done = (ok) => {
      socket.destroy();
      resolvePromise(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

function buildEnv(extra = {}) {
  return {
    ...process.env,
    WRANGLER_LOG_PATH: process.env.WRANGLER_LOG_PATH || ".wrangler/wrangler.log",
    WRANGLER_WRITE_LOGS: process.env.WRANGLER_WRITE_LOGS || "false",
    MINIFLARE_REGISTRY_PATH: process.env.MINIFLARE_REGISTRY_PATH || ".wrangler/registry",
    ...extra,
  };
}

function ensureBuild() {
  if (isDev) return;
  const distDir = resolve(rootDir, "dist");
  if (!forceRebuild && existsSync(distDir)) return;

  console.log("[doorwatch] Building web UI (vinext build)...");
  const result = spawnSync(process.execPath, [vinextCli, "build"], {
    cwd: rootDir,
    stdio: "inherit",
    env: buildEnv({ NODE_ENV: "production" }),
  });

  if (result.status !== 0) {
    console.error("[doorwatch] Web UI build failed.");
    process.exit(result.status ?? 1);
  }
}

async function main() {
  checkNodeVersion();

  if (!existsSync(vinextCli)) {
    console.error("[doorwatch] Missing dependencies. Run `npm install` first.");
    process.exit(1);
  }

  const mongoTarget = parseMongoHostPort(mongoUri);
  if (!mongoTarget.isSrv) {
    const maxAttempts = waitMongo ? 30 : 1;
    let reachable = false;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      reachable = await checkTcpPort(mongoTarget.host, mongoTarget.port);
      if (reachable) break;
      if (attempt < maxAttempts) {
        if (attempt === 1) {
          console.log(
            `[doorwatch] Waiting for MongoDB at ${mongoTarget.host}:${mongoTarget.port}...`
          );
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 2000));
      }
    }
    if (!reachable) {
      console.error(
        `[doorwatch] Cannot reach MongoDB at ${mongoTarget.host}:${mongoTarget.port} (${mongoUri}).`
      );
      console.error(
        "[doorwatch] Make sure MongoDB Community Server is installed and running on Windows (e.g. `net start MongoDB`)."
      );
      process.exit(1);
    }
  }

  ensureBuild();

  const children = [];
  let shuttingDown = false;

  const shutdown = (exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("\n[doorwatch] Shutting down services...");
    for (const child of children) {
      if (!child.killed) {
        child.kill("SIGTERM");
      }
    }
    setTimeout(() => {
      for (const child of children) {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
      }
      process.exit(exitCode);
    }, 3000).unref();
  };

  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));

  const startChild = (name, scriptArgs, extraEnv = {}) => {
    const child = spawn(process.execPath, scriptArgs, {
      cwd: rootDir,
      stdio: "inherit",
      env: buildEnv(extraEnv),
    });
    child.on("exit", (code, signal) => {
      if (shuttingDown) return;
      console.error(`[doorwatch] ${name} exited (code=${code ?? "null"}, signal=${signal ?? "none"}).`);
      shutdown(code ?? 1);
    });
    children.push(child);
    return child;
  };

  const serverEnv = {
    API_PORT: apiPort,
  };

  if (withSimulator) {
    console.log(`[doorwatch] Starting ZKBio simulator on http://127.0.0.1:${mockPort}`);
    startChild("zkbio-simulator", ["server/mock-zkbio.mjs"], {
      MOCK_ZKBIO_PORT: mockPort,
      MOCK_ZKBIO_TOKEN: mockToken,
    });
    serverEnv.ZKBIO_SIMULATOR_URL = process.env.ZKBIO_SIMULATOR_URL || `http://127.0.0.1:${mockPort}`;
    serverEnv.ZKBIO_SIMULATOR_TOKEN = process.env.ZKBIO_SIMULATOR_TOKEN || mockToken;
  }

  console.log(`[doorwatch] Starting API & collector on http://127.0.0.1:${apiPort}`);
  startChild("collector-api", ["server/index.mjs"], serverEnv);

  const webCommand = isDev ? "dev" : "start";
  console.log(`[doorwatch] Starting web UI (${webCommand}) on http://localhost:${webPort}`);
  startChild(
    "web-ui",
    [vinextCli, webCommand, "--host", "0.0.0.0", "--port", webPort],
    isDev ? {} : { NODE_ENV: "production" }
  );
}

main().catch((error) => {
  console.error("[doorwatch] Fatal startup error:", error);
  process.exit(1);
});
