# DoorWatch User Guide

**DoorWatch** is a local monitoring dashboard and background collector for **ZKBio CVSecurity** door access systems. It detects card/face/PIN scans, monitors physical door open/close sensor states, correlates granted scans with physical door openings, and forwards verified entry events to your server via webhook.

---

## 1. How DoorWatch Works

1. **Card / Face / PIN Scan Detection**
   - Every 10 seconds, DoorWatch polls ZKBio (`/api/transaction/monitor` and periodic backfill via `/api/v2/transaction/list`).
   - Each transaction is normalized and classified as:
     - `access_granted` — valid scan/swipe/verification
     - `access_denied` — unregistered card, expired access, anti-passback, or denied entry
     - `access_alarm` — duress, tamper, or forced alarm

2. **Physical Door Sensor Detection (Door Slide / Open & Close)**
   - Every 10 seconds, DoorWatch polls `/api/door/allDoorState` to check each door's physical `sensor` (`open` / `closed`), `relay`, `alarm`, and `connect` status.
   - When a door physically slides or swings open (`sensor` changes to `open`), DoorWatch records a `door_opened` transition event. When it closes, it records `door_closed`.

3. **Scan + Door Opening Correlation**
   - If a door physically opens (`door_opened`) within **20 seconds** of an `access_granted` scan on that same door, DoorWatch links the two events together (`access_granted_opened`, shown as **Granted · opened** in the UI).
   - Correlated events automatically trigger the **Outbound Webhook** (if enabled).

---

## 2. Starting DoorWatch

### Option A: Using Docker Compose (Recommended)

1. Create your `.env` file from the template:
   ```bash
   cp .env.example .env
   ```
2. *(Recommended)* Edit `.env` and change `ADMIN_PASSWORD` before starting for the first time.
3. Start the containers:
   ```bash
   docker compose up -d --build
   ```
4. Open the web dashboard at:
   - **Local browser:** `http://localhost:3080`
   - **Other devices on the LAN:** `http://YOUR-SERVER-IP:3080`

### Option B: Local Development (Node.js + Local MongoDB)

1. Make sure MongoDB is running locally on `127.0.0.1:27017`.
2. Copy `.env.example` to `.env` and install dependencies:
   ```bash
   cp .env.example .env
   npm install
   npm run dev
   ```
3. Open `http://localhost:3000`.

---

## 3. Signing In

Sign in using the administrator account configured in `.env` on first startup:

- **Default Username:** `admin`
- **Default Password:** `DoorWatch@123`

> **Note:** `ADMIN_USERNAME` and `ADMIN_PASSWORD` only provision the initial admin account when the MongoDB `users` collection has no matching user.

---

## 4. Configuring ZKBio or Testing with the Built-In Simulator

Click **Settings** in the left navigation bar.

### Testing Without Hardware (ZKBio Device Simulator)

Docker Compose automatically runs a local ZKBio simulator (`zkbio-mock`) so you can test the entire workflow before connecting physical door hardware:

1. In **Settings**, scroll down to **ZKBio device simulator**.
2. Click **Connect demo server** — this configures DoorWatch to poll `http://zkbio-mock:8080` with token `demo-token`.
3. Click **Simulate granted scan + open**:
   - Generates a granted scan transaction (`TEST-001` / `Demo Visitor`).
   - Collects the scan into MongoDB.
   - Opens the simulated physical door sensor (`open`).
   - Correlates the scan and door opening into **Granted · opened** (`access_granted_opened`).
   - Queues the outbound webhook delivery (if enabled).
4. Click **Simulate denied scan** to test a rejected access attempt (`access_denied`).
5. Click **Close demo door** to return the door sensor and relay to `closed`.

### Connecting a Real ZKBio CVSecurity Server

1. In **Settings → Connection**, fill in:
   - **Server URL:** Your ZKBio server address and port (e.g., `https://192.168.1.100:8088`).
   - **API access token:** Your ZKBio API token. (Once saved, the token is encrypted with AES-256-GCM and never sent back to the browser.)
   - **Enable background collector:** Checked.
2. In **Settings → Collector behavior**:
   - **Polling interval:** `Every 10 seconds` (recommended minimum) up to `Every 60 seconds`.
   - **Request timeout:** `5` to `30` seconds (default `8 seconds`).
   - **Allow self-signed HTTPS certificate:** Enable this if your local ZKBio server uses a self-signed TLS certificate.
3. Click **Save and test connection**.
   - A green banner will confirm how many doors were discovered and the response time in milliseconds.

---

## 5. Setting Up the Outbound Webhook

DoorWatch can send an HTTP `POST` request to an external server whenever a valid scan is followed by a physical door opening (`access.granted_opened`).

1. Go to **Settings → Outbound webhook**.
2. Check **Enable webhook delivery**.
3. Enter your **Destination URL or template**:
   - **Fixed URL example:**
     ```text
     https://example.com/api/door-events
     ```
   - **Dynamic URL template example:**
     ```text
     https://example.com/api/attendance/{{person.pin}}?door={{door.id}}
     ```
   - **Supported URL placeholders** (URL-encoded automatically, allowed in path/query/fragment):
     - `{{id}}` — correlation ID (`access-open:...`)
     - `{{collectorId}}` — local collector identifier
     - `{{person.pin}}` — user/employee PIN
     - `{{person.cardNumber}}` — card number
     - `{{door.id}}` — ZKBio door ID
     - `{{door.name}}` — door name
     - `{{device.serialNumber}}` — device serial number
4. *(Optional)* Enter a **Bearer token** — sent in the `Authorization: Bearer <token>` header.
5. Select a **Request timeout** and click **Save and send test POST**.

### Webhook Payload Example

```json
{
  "version": "1.0",
  "type": "access.granted_opened",
  "id": "access-open:688eb1...",
  "occurredAt": "2026-08-03T01:41:14.000Z",
  "collectorId": "doorwatch-local-01",
  "person": {
    "pin": "57",
    "name": "Sok Dara",
    "cardNumber": "9606650"
  },
  "access": {
    "result": "granted",
    "verificationMode": "Face",
    "eventName": "Normal Verify Open",
    "scanTime": "2026-08-03T01:41:10.000Z",
    "readerName": "Main Entrance-In",
    "areaName": "Head Office"
  },
  "door": {
    "id": "door-1",
    "name": "Main entrance",
    "openedAt": "2026-08-03T01:41:14.000Z",
    "sensor": "open",
    "relay": "unlocked",
    "alarm": "none",
    "connection": "online"
  },
  "device": {
    "serialNumber": "7633223440032",
    "name": "Front Controller",
    "deviceId": "dev-1"
  },
  "raw": {
    "transaction": {},
    "doorState": {}
  }
}
```

> **Retries:** If your destination server is unreachable or returns a non-2xx HTTP status, DoorWatch stores the event in `webhook_outbox` and retries automatically with exponential backoff up to **10 attempts**.

---

## 6. Using the Dashboard Views

Use the left sidebar to navigate between the five main screens:

### Live Monitor
- Displays real-time summary cards:
  - **Doors online** (`online / total` and offline count)
  - **Open now** (doors whose physical sensor is currently `open`)
  - **Scans today** (total scans today and denied count)
  - **Active alerts** (offline doors or active door alarms)
- **Recent activity table:** Streams the latest 25 events live via Server-Sent Events (`/api/live`).
- **Event detail panel:** Click any row in the table to inspect the person's name/PIN/card, door name, verification mode, reader name, physical sensor state, and alarm status.

### Doors
- Displays a card for each door reported by ZKBio with its current:
  - **Connection status:** `Online`, `Offline`, or `Alarm`
  - **Sensor state:** `open`, `closed`, `no sensor`
  - **Relay state:** `locked` / `unlocked` / `closed` / `open`
  - **Alarm state:** `none` or active alarm type
  - **Checked time:** Timestamp of the most recent poll

### Event History
- Search and filter up to the latest 100 stored events in MongoDB:
  - **Search box:** Filter by person name, PIN, card number, door name, or event name.
  - **Result filter:** Filter by `All results`, `Granted`, `Denied`, `Warnings`, or `Critical`.

### System Health
- Shows operational status across three health panels:
  - **MongoDB:** Connection state, database name, and connected timestamp.
  - **ZKBio collector:** Polling interval, last successful poll time, API response time (ms), and total events saved.
  - **Central forwarding:** Indicates whether remote central-server forwarding (`CENTRAL_SERVER_URL`) is active or in local-only mode, plus pending upload count.

---

## 7. Common Maintenance Commands

```bash
# View live logs
docker compose logs -f doorwatch

# Restart the DoorWatch service
docker compose restart doorwatch

# Stop containers (preserves MongoDB data and encryption keys)
docker compose down
```
