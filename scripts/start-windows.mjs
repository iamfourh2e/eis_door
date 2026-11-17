import "dotenv/config";
import { spawn, spawnSync } from "node:child_process";
import { createReadStream, existsSync, statSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { extname, resolve, sep } from "node:path";

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

function getEphemeralPort() {
  return new Promise((resolvePromise, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolvePromise(port));
    });
  });
}

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

function startWindowsStaticProxy(publicPort, upstreamPort) {
  const clientDir = resolve(rootDir, "dist/client");
  const server = http.createServer((req, res) => {
    const rawUrl = req.url || "/";
    const pathnameOnly = rawUrl.split("?")[0];
    if ((req.method === "GET" || req.method === "HEAD") && pathnameOnly !== "/" && !pathnameOnly.startsWith("/.vite")) {
      try {
        const decoded = decodeURIComponent(pathnameOnly).replace(/^\/+/, "");
        const filePath = resolve(clientDir, decoded);
        if (filePath.startsWith(clientDir + sep) && existsSync(filePath)) {
          const stats = statSync(filePath);
          if (stats.isFile()) {
            const ext = extname(filePath).toLowerCase();
            const isHashed = pathnameOnly.startsWith("/assets/");
            res.writeHead(200, {
              "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
              "Content-Length": String(stats.size),
              "Cache-Control": isHashed ? "public, max-age=31536000, immutable" : "public, max-age=3600",
            });
            if (req.method === "HEAD") {
              res.end();
              return;
            }
            createReadStream(filePath).pipe(res);
            return;
          }
        }
      } catch {
        // Fall through to upstream vinext server
      }
    }

    const proxyReq = http.request(
      {
        hostname: "127.0.0.1",
        port: upstreamPort,
        path: rawUrl,
        method: req.method,
        headers: req.headers,
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
        proxyRes.pipe(res);
      },
    );
    proxyReq.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain" });
      res.end("Upstream web server is starting...");
    });
    req.pipe(proxyReq);
  });

  server.listen(Number(publicPort), "0.0.0.0");
  return server;
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
  let proxyServer;
  let shuttingDown = false;

  const shutdown = (exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("\n[doorwatch] Shutting down services...");
    proxyServer?.close();
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
  if (!isDev && process.platform === "win32") {
    // vinext@0.0.50 StaticFileCache keys paths using OS separators (`\` on Windows),
    // causing `/assets/*` 404s in `vinext start`. Serve `dist/client` directly here.
    const internalWebPort = String(await getEphemeralPort());
    proxyServer = startWindowsStaticProxy(webPort, Number(internalWebPort));
    console.log(`[doorwatch] Starting web UI (start + Windows static proxy) on http://localhost:${webPort}`);
    startChild(
      "web-ui",
      [vinextCli, "start", "--host", "127.0.0.1", "--port", internalWebPort],
      { NODE_ENV: "production" }
    );
  } else {
    console.log(`[doorwatch] Starting web UI (${webCommand}) on http://localhost:${webPort}`);
    startChild(
      "web-ui",
      [vinextCli, webCommand, "--host", "0.0.0.0", "--port", webPort],
      isDev ? {} : { NODE_ENV: "production" }
    );
  }
}

main().catch((error) => {
  console.error("[doorwatch] Fatal startup error:", error);
  process.exit(1);
});
