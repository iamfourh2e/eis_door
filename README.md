# DoorWatch Local

DoorWatch is a local web dashboard and background collector for ZKBio CVSecurity. It polls access transactions and physical door state every 10 seconds, stores normalized and raw records in MongoDB, detects door transitions, and optionally forwards events to a central server.

## Quick start with Docker

1. Copy `.env.example` to `.env` and change `ADMIN_PASSWORD` before the first startup.
2. Run `docker compose up -d --build`.
3. Open `http://localhost:3080` and sign in.
4. Open **Settings**, enter the ZKBio server URL and API token, then select **Save and test connection**.

The initial development login is:

```text
Username: admin
Password: DoorWatch@123
```

`ADMIN_USERNAME` and `ADMIN_PASSWORD` provision the first administrator only when the MongoDB `users` collection has no matching account. Changing those environment values later does not overwrite an existing password.

The API and live event stream run on port `4000`. Other devices on the LAN can use `http://YOUR-SERVER-IP:3080`.

## Build the Docker image

The root `Dockerfile` builds the web UI, API, collector, webhook worker, and simulator code into one production image.

### 1. Build for the destination server

From the project directory, build for a typical 64-bit Intel/AMD Linux server:

```bash
docker buildx build \
  --platform linux/amd64 \
  --load \
  -t doorwatch-local:1.0.0-amd64 .
```

For an ARM64 server, replace `linux/amd64` with `linux/arm64` and use a matching image tag and Compose configuration.

### 2. Export and compress the image

```bash
docker save \
  -o doorwatch-local-1.0.0-amd64.tar \
  doorwatch-local:1.0.0-amd64

gzip -9 doorwatch-local-1.0.0-amd64.tar
```

The result is the portable image file:

```text
doorwatch-local-1.0.0-amd64.tar.gz
```

Generate a checksum before transferring it:

```bash
shasum -a 256 doorwatch-local-1.0.0-amd64.tar.gz
```

### 3. Transfer the release to another server

Copy the complete release directory so the image, Compose file, environment example, and deployment guide stay together:

```bash
scp -r release/doorwatch-1.0.0-amd64 \
  YOUR_USER@YOUR_SERVER_IP:/opt/doorwatch
```

You may also transfer the directory using USB storage or another secure file-sharing method.

### 4. Import the image on the destination server

```bash
ssh YOUR_USER@YOUR_SERVER_IP
cd /opt/doorwatch/doorwatch-1.0.0-amd64

docker load -i doorwatch-local-1.0.0-amd64.tar.gz
docker image ls doorwatch-local
```

### 5. Configure and start DoorWatch

Create the runtime environment file and change the administrator password before the first startup:

```bash
cp .env.example .env
nano .env
```

At minimum, review these values:

```env
ADMIN_USERNAME=admin
ADMIN_PASSWORD=YourStrongPassword
DOORWATCH_WEB_PORT=3080
DOORWATCH_API_PORT=4000
```

Start the complete stack:

```bash
docker compose up -d
docker compose ps
```

Open `http://YOUR_SERVER_IP:3080` and sign in with the administrator credentials from `.env`.

### Docker operations

Follow startup and runtime logs:

```bash
docker compose logs -f doorwatch
```

Restart only DoorWatch:

```bash
docker compose restart doorwatch
```

Stop the stack without deleting MongoDB records or encryption/session keys:

```bash
docker compose down
```

Do not add `-v` to `docker compose down` unless you intentionally want to delete the persistent DoorWatch database and secret volumes.

### Offline destination server

The DoorWatch image does not contain MongoDB. If the destination server cannot access Docker Hub, export the MongoDB image on the build computer too:

```bash
docker pull --platform linux/amd64 mongo:8
docker save -o mongo-8.tar mongo:8
gzip -9 mongo-8.tar
```

Transfer `mongo-8.tar.gz` with the DoorWatch release, then import both images on the destination server:

```bash
docker load -i doorwatch-local-1.0.0-amd64.tar.gz
docker load -i mongo-8.tar.gz
docker compose up -d
```

### Container ports and security

The production image runs:

- UI on container port `3000`, published as `3080`
- API, collector, and webhook worker on container port `4000`

Set `AUTH_COOKIE_SECURE=true` when the app is served through HTTPS. Keep the generated session and configuration keys in the `doorwatch-secrets` volume.

## Local development

Start MongoDB, copy `.env.example` to `.env`, then run:

```bash
npm install
npm run dev
```

The web UI and collector/API start together. ZKBio polling is limited to a minimum interval of 10 seconds. Environment variables remain available as initial fallback values, but end users can configure ZKBio from the Settings screen.

## Data stored in MongoDB

- `events`: access scans, denials, alarms, door transitions, and raw ZKBio payloads
- `doors`: current sensor, relay, connection, and alarm state
- `collector_state`: latest collector health and counters
- `settings`: ZKBio connection settings; the API token is AES-256-GCM encrypted
- `webhook_outbox`: durable outbound POST deliveries and retry history
- `users`: administrator identities with salted scrypt password hashes

The `events.sourceKey` index prevents duplicate records. If `CENTRAL_SERVER_URL` is configured, unsent events remain pending in MongoDB and retry automatically.

## API

- `GET /api/health`
- `GET /api/dashboard`
- `GET /api/events`
- `GET /api/doors`
- `GET /api/live` (server-sent events)
- `POST /api/ingest/events` (central-server receiving endpoint)
- `GET /api/settings/zkbio` (returns masked configuration)
- `PUT /api/settings/zkbio` (saves and tests the connection)
- `GET /api/settings/webhook` (masked outbound webhook configuration and delivery status)
- `PUT /api/settings/webhook` (saves configuration and sends a test POST)

After the token is saved, it is never returned to the browser. Docker stores the encryption key in the persistent `doorwatch-secrets` volume.

## Outbound webhook

Configure the destination in **Settings → Outbound webhook**. When DoorWatch correlates a granted scan with a physical door opening within 20 seconds, it sends:

```json
{
  "version": "1.0",
  "type": "access.granted_opened",
  "id": "access-open:...",
  "occurredAt": "2026-08-03T01:41:14.000Z",
  "collectorId": "doorwatch-local-01",
  "person": { "pin": "57", "name": "Sok Dara", "cardNumber": "9606650" },
  "access": { "result": "granted", "verificationMode": "Face" },
  "door": { "id": "door-1", "name": "Main entrance", "sensor": "open" },
  "device": { "serialNumber": "7633223440032" },
  "raw": { "transaction": {}, "doorState": {} }
}
```

Requests use `Content-Type: application/json`, `X-DoorWatch-Event`, and `X-DoorWatch-Delivery` headers. If a bearer token is configured, DoorWatch sends it in the `Authorization` header. Non-2xx responses and network failures retry with exponential backoff up to 10 attempts.

The destination can be a fixed URL or a dynamic URL template. For example, `https://example.com/events/{{person.pin}}` sends person `57` to `https://example.com/events/57`. You can use `{{id}}`, `{{collectorId}}`, `{{person.pin}}`, `{{person.cardNumber}}`, `{{door.id}}`, `{{door.name}}`, and `{{device.serialNumber}}` in the path or query string. Values are URL-encoded, placeholders cannot change the destination host, and the complete event remains available in the POST body.

## ZKBio simulator

Docker Compose starts a local ZKBio-compatible simulator automatically. Open **Settings → ZKBio device simulator** and select **Connect demo server**. The simulator provides the same door-state, transaction-monitor, and transaction-history endpoints used by the collector.

- **Simulate granted scan + open** creates a granted transaction, collects it, changes the physical door sensor to open, correlates both events, stores them in MongoDB, and queues the outbound webhook.
- **Simulate denied scan** creates a denied transaction through the same collector pipeline.
- **Close demo door** restores the demo sensor and relay to their closed states.

The simulator is exposed at `http://localhost:8090` for diagnostics. Its internal DoorWatch URL is `http://zkbio-mock:8080`, with the demo token `demo-token`.
