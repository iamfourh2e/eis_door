import express from "express";

const app = express();
const port = Number.parseInt(process.env.MOCK_ZKBIO_PORT || "8080", 10);
const accessToken = process.env.MOCK_ZKBIO_TOKEN || "demo-token";

app.disable("x-powered-by");
app.use(express.json({ limit: "256kb" }));

const defaultDoor = () => ({
  id: "demo-door-1",
  name: "Demo Front Door",
  deviceId: "demo-device-1",
  connect: "1",
  sensor: "closed",
  relay: "closed",
  alarm: "none",
});

let door = defaultDoor();
let sequence = 1_000;
let transactions = [];

function timestamp(date = new Date()) {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

function transaction(input = {}, granted = true) {
  const logId = sequence++;
  return {
    id: logId,
    logId,
    pin: String(input.pin || (granted ? "TEST-001" : "TEST-002")),
    name: String(input.name || (granted ? "Demo Visitor" : "Unknown Visitor")),
    lastName: "",
    cardNo: String(input.cardNumber || (granted ? "CARD-1001" : "CARD-DENIED")),
    verifyModeName: String(input.verificationMode || "Card"),
    devSn: "TEST-DEVICE",
    devName: "ZKBio Simulator",
    doorName: door.name,
    eventPointName: door.name,
    readerName: "Demo Entry Reader",
    areaName: "Demo Lobby",
    eventName: granted ? "Normal Verify Open" : "Access Denied",
    eventNo: granted ? 0 : 1,
    eventLevel: granted ? 0 : 1,
    eventTime: timestamp(),
    capturePhotoBase64: "",
    delivered: false,
  };
}

function publicTransaction(item) {
  const copy = { ...item };
  delete copy.delivered;
  return copy;
}

function requireToken(request, response, next) {
  if (request.query.access_token !== accessToken) {
    return response.status(200).json({ code: -1, message: "Invalid access token", data: null });
  }
  next();
}

app.get("/health", (_request, response) => response.json({ ok: true, service: "zkbio-simulator" }));
app.use("/api", requireToken);

app.get("/api/door/allDoorState", (_request, response) => {
  response.json({ code: 0, message: "success", data: [{ ...door }] });
});

app.get("/api/transaction/monitor", (_request, response) => {
  const pending = transactions.filter((item) => !item.delivered);
  pending.forEach((item) => { item.delivered = true; });
  response.json({ code: 0, message: "success", data: pending.map(publicTransaction) });
});

app.get("/api/v2/transaction/list", (_request, response) => {
  response.json({
    code: 0,
    message: "success",
    data: transactions.map(publicTransaction),
  });
});

app.get("/simulator/status", (_request, response) => {
  response.json({ door, queuedTransactions: transactions.filter((item) => !item.delivered).length, transactionCount: transactions.length });
});

app.post("/simulator/scan/granted", (request, response) => {
  const created = transaction(request.body, true);
  transactions.push(created);
  response.status(201).json({ ok: true, transaction: created });
});

app.post("/simulator/scan/denied", (request, response) => {
  const created = transaction(request.body, false);
  transactions.push(created);
  response.status(201).json({ ok: true, transaction: created });
});

app.post("/simulator/door/open", (_request, response) => {
  door = { ...door, sensor: "open", relay: "open" };
  response.json({ ok: true, door });
});

app.post("/simulator/door/close", (_request, response) => {
  door = { ...door, sensor: "closed", relay: "closed", alarm: "none", connect: "1" };
  response.json({ ok: true, door });
});

app.post("/simulator/reset", (_request, response) => {
  door = defaultDoor();
  transactions = [];
  response.json({ ok: true, door });
});

app.listen(port, "0.0.0.0", () => {
  console.log(`ZKBio simulator listening on http://localhost:${port}`);
});
