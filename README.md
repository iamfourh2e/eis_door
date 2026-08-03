# DoorWatch Local

DoorWatch is a local web dashboard and background collector for ZKBio CVSecurity. It polls access transactions and physical door state every 10 seconds, stores normalized and raw records in MongoDB, detects door transitions, and optionally forwards events to a central server.

## Quick start with Docker

1. Run `docker compose up --build`.
2. Open `http://localhost:3080`.
3. Open **Settings**, enter the ZKBio server URL and API token, then select **Save and test connection**.

The API and live event stream run on port `4000`. Other devices on the LAN can use `http://YOUR-SERVER-IP:3080`.

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
