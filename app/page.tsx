"use client";

import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  CircleUserRound,
  Database,
  DoorClosed,
  DoorOpen,
  Filter,
  HeartPulse,
  History,
  KeyRound,
  LockKeyhole,
  Menu,
  Radio,
  ScanFace,
  Search,
  Server,
  Send,
  Settings2,
  ShieldAlert,
  Wifi,
  WifiOff,
  Webhook,
  X,
} from "lucide-react";
import type { FormEvent } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

type Dashboard = {
  totalDoors: number;
  onlineDoors: number;
  openDoors: number;
  activeAlerts: number;
  scansToday: number;
  deniedToday: number;
  pendingUploads: number;
};

type Door = {
  _id: string;
  doorId: string;
  name: string;
  deviceId: string;
  connect: string;
  sensor: string;
  relay: string;
  alarm: string;
  checkedAt: string;
};

type DoorEvent = {
  _id: string;
  eventTime: string;
  eventType: string;
  severity: string;
  accessResult?: string;
  personName?: string;
  personPin?: string;
  cardNumber?: string;
  doorName?: string;
  verificationMode?: string;
  eventName?: string;
  readerName?: string;
  sensorState?: string;
  relayState?: string;
  alarmState?: string;
  delivery?: { status?: string };
};

type Health = {
  mongo: { connected: boolean; error?: string; database: string; connectedAt?: string };
  collector: {
    running: boolean;
    configured: boolean;
    configurationIssue?: string;
    lastPollAt?: string;
    lastSuccessAt?: string;
    lastError?: string;
    lastDurationMs?: number;
    pollIntervalMs: number;
    centralForwarding: boolean;
    eventsInserted: number;
    transactionsReceived: number;
    doorsChecked: number;
  };
  liveClients: number;
  serverTime: string;
};

type ZkbioSettings = {
  enabled: boolean;
  baseUrl: string;
  accessTokenConfigured: boolean;
  pollIntervalMs: number;
  timeoutMs: number;
  allowInsecureTls: boolean;
  updatedAt?: string;
};

type SettingsForm = {
  enabled: boolean;
  baseUrl: string;
  accessToken: string;
  pollIntervalMs: number;
  timeoutMs: number;
  allowInsecureTls: boolean;
};

type WebhookSettings = {
  enabled: boolean;
  url: string;
  secretConfigured: boolean;
  timeoutMs: number;
  eventType: string;
  updatedAt?: string;
};

type WebhookForm = {
  enabled: boolean;
  url: string;
  secret: string;
  timeoutMs: number;
};

const emptyDashboard: Dashboard = {
  totalDoors: 0,
  onlineDoors: 0,
  openDoors: 0,
  activeAlerts: 0,
  scansToday: 0,
  deniedToday: 0,
  pendingUploads: 0,
};

function apiBase() {
  if (typeof window === "undefined") return "http://localhost:4000/api";
  return `${window.location.protocol}//${window.location.hostname}:4000/api`;
}

function formatTime(value?: string) {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-KH", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function formatDateTime(value?: string) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-KH", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function eventLabel(event: DoorEvent) {
  if (event.eventType === "access_granted") return "Granted";
  if (event.eventType === "access_granted_opened") return "Granted · opened";
  if (event.eventType === "access_denied") return "Denied";
  if (event.eventType === "door_opened") return "Door opened";
  if (event.eventType === "door_closed") return "Door closed";
  if (event.eventType === "door_alarm") return "Door alarm";
  if (event.eventType === "device_offline") return "Device offline";
  return event.eventName || event.eventType.replaceAll("_", " ");
}

function statusTone(event: DoorEvent) {
  if (event.severity === "critical" || event.accessResult === "denied") return "danger";
  if (event.severity === "warning") return "warning";
  if (event.accessResult === "granted") return "success";
  return "neutral";
}

export default function Home() {
  const [view, setView] = useState("live");
  const [mobileNav, setMobileNav] = useState(false);
  const [dashboard, setDashboard] = useState(emptyDashboard);
  const [doors, setDoors] = useState<Door[]>([]);
  const [events, setEvents] = useState<DoorEvent[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [selected, setSelected] = useState<DoorEvent | null>(null);
  const [search, setSearch] = useState("");
  const [resultFilter, setResultFilter] = useState("all");
  const [loading, setLoading] = useState(true);
  const [apiError, setApiError] = useState("");
  const [savedSettings, setSavedSettings] = useState<ZkbioSettings | null>(null);
  const [settingsForm, setSettingsForm] = useState<SettingsForm>({
    enabled: true,
    baseUrl: "",
    accessToken: "",
    pollIntervalMs: 10_000,
    timeoutMs: 8_000,
    allowInsecureTls: false,
  });
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsMessage, setSettingsMessage] = useState<{ tone: "success" | "warning"; text: string } | null>(null);
  const [savedWebhook, setSavedWebhook] = useState<WebhookSettings | null>(null);
  const [webhookForm, setWebhookForm] = useState<WebhookForm>({ enabled: false, url: "", secret: "", timeoutMs: 8_000 });
  const [webhookStatus, setWebhookStatus] = useState<Record<string, number>>({});
  const [webhookSaving, setWebhookSaving] = useState(false);
  const [webhookMessage, setWebhookMessage] = useState<{ tone: "success" | "warning"; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const base = apiBase();
      const healthResponse = await fetch(`${base}/health`, { cache: "no-store" });
      if (!healthResponse.ok) throw new Error("Local collector API is not available");
      const nextHealth = (await healthResponse.json()) as Health;
      setHealth(nextHealth);

      if (nextHealth.mongo.connected) {
        const [dashboardResponse, doorsResponse, eventsResponse] = await Promise.all([
          fetch(`${base}/dashboard`, { cache: "no-store" }),
          fetch(`${base}/doors`, { cache: "no-store" }),
          fetch(`${base}/events?limit=100`, { cache: "no-store" }),
        ]);
        if (!dashboardResponse.ok || !doorsResponse.ok || !eventsResponse.ok) {
          throw new Error("Could not load monitoring data");
        }
        const [nextDashboard, nextDoors, nextEvents] = await Promise.all([
          dashboardResponse.json() as Promise<Dashboard>,
          doorsResponse.json() as Promise<Door[]>,
          eventsResponse.json() as Promise<DoorEvent[]>,
        ]);
        setDashboard(nextDashboard);
        setDoors(nextDoors);
        setEvents(nextEvents);
        setSelected((current) => current ?? nextEvents[0] ?? null);
      }
      setApiError("");
    } catch (error) {
      setApiError(error instanceof Error ? error.message : "Unable to reach the local service");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const firstLoad = window.setTimeout(load, 0);
    const refresh = window.setInterval(load, 15_000);
    const stream = new EventSource(`${apiBase()}/live`);
    stream.addEventListener("event", load);
    stream.addEventListener("doors", load);
    stream.addEventListener("health", (message) => {
      const collector = JSON.parse((message as MessageEvent).data);
      setHealth((current) => (current ? { ...current, collector } : current));
    });
    return () => {
      window.clearTimeout(firstLoad);
      window.clearInterval(refresh);
      stream.close();
    };
  }, [load]);

  const loadSettings = useCallback(async () => {
    try {
      const [response, webhookResponse] = await Promise.all([
        fetch(`${apiBase()}/settings/zkbio`, { cache: "no-store" }),
        fetch(`${apiBase()}/settings/webhook`, { cache: "no-store" }),
      ]);
      if (!response.ok || !webhookResponse.ok) throw new Error("Could not load integration settings");
      const settings = (await response.json()) as ZkbioSettings;
      const webhookResult = (await webhookResponse.json()) as { settings: WebhookSettings; status: Record<string, number> };
      setSavedSettings(settings);
      setSettingsForm({
        enabled: settings.enabled,
        baseUrl: settings.baseUrl,
        accessToken: "",
        pollIntervalMs: settings.pollIntervalMs,
        timeoutMs: settings.timeoutMs,
        allowInsecureTls: settings.allowInsecureTls,
      });
      setSavedWebhook(webhookResult.settings);
      setWebhookStatus(webhookResult.status || {});
      setWebhookForm({
        enabled: webhookResult.settings.enabled,
        url: webhookResult.settings.url,
        secret: "",
        timeoutMs: webhookResult.settings.timeoutMs,
      });
    } catch (error) {
      setSettingsMessage({ tone: "warning", text: error instanceof Error ? error.message : "Could not load settings" });
    }
  }, []);

  useEffect(() => {
    if (view !== "settings") return;
    const timer = window.setTimeout(loadSettings, 0);
    return () => window.clearTimeout(timer);
  }, [loadSettings, view]);

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSettingsSaving(true);
    setSettingsMessage(null);
    try {
      const response = await fetch(`${apiBase()}/settings/zkbio`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(settingsForm),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not save settings");
      setSavedSettings(result.settings);
      setSettingsForm((current) => ({ ...current, accessToken: "" }));
      if (result.connectionTest?.ok) {
        setSettingsMessage({ tone: "success", text: `Connected successfully. ${result.connectionTest.doorCount} doors found in ${result.connectionTest.responseTimeMs} ms.` });
      } else {
        setSettingsMessage({ tone: "warning", text: `Settings saved, but the connection test failed: ${result.connectionTest?.error || "Unknown error"}` });
      }
      await load();
    } catch (error) {
      setSettingsMessage({ tone: "warning", text: error instanceof Error ? error.message : "Could not save settings" });
    } finally {
      setSettingsSaving(false);
    }
  }

  async function saveWebhook(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setWebhookSaving(true);
    setWebhookMessage(null);
    try {
      const response = await fetch(`${apiBase()}/settings/webhook`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(webhookForm),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not save webhook settings");
      setSavedWebhook(result.settings);
      setWebhookStatus(result.status || {});
      setWebhookForm((current) => ({ ...current, secret: "" }));
      if (result.connectionTest?.ok && !result.connectionTest?.skipped) {
        setWebhookMessage({ tone: "success", text: `Test POST delivered successfully with HTTP ${result.connectionTest.responseStatus}.` });
      } else if (result.connectionTest?.skipped) {
        setWebhookMessage({ tone: "success", text: "Webhook settings saved. Delivery remains disabled." });
      } else {
        setWebhookMessage({ tone: "warning", text: `Settings saved, but the test POST failed: ${result.connectionTest?.error || "Unknown error"}` });
      }
    } catch (error) {
      setWebhookMessage({ tone: "warning", text: error instanceof Error ? error.message : "Could not save webhook settings" });
    } finally {
      setWebhookSaving(false);
    }
  }

  const visibleEvents = useMemo(() => {
    const query = search.trim().toLowerCase();
    return events.filter((event) => {
      if (resultFilter !== "all" && event.accessResult !== resultFilter && event.severity !== resultFilter) {
        return false;
      }
      if (!query) return true;
      return [event.personName, event.personPin, event.cardNumber, event.doorName, event.eventName]
        .filter(Boolean)
        .some((value) => value!.toLowerCase().includes(query));
    });
  }, [events, resultFilter, search]);

  const connected = Boolean(health?.mongo.connected && health?.collector.configured && !health?.collector.lastError);
  const navItems = [
    { id: "live", label: "Live monitor", icon: Activity },
    { id: "doors", label: "Doors", icon: DoorClosed },
    { id: "events", label: "Event history", icon: History },
    { id: "system", label: "System health", icon: HeartPulse },
    { id: "settings", label: "Settings", icon: Settings2 },
  ];

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileNav ? "open" : ""}`}>
        <div className="brand">
          <span className="brand-mark"><DoorOpen size={20} /></span>
          <span><strong>DoorWatch</strong><small>Local access monitor</small></span>
        </div>
        <button className="mobile-close" onClick={() => setMobileNav(false)} aria-label="Close navigation"><X size={20} /></button>
        <nav aria-label="Primary navigation">
          {navItems.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={view === id ? "active" : ""}
              onClick={() => { setView(id); setMobileNav(false); }}
            >
              <Icon size={18} /><span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="collector-card">
          <span className={`connection-dot ${connected ? "online" : "offline"}`} />
          <div><strong>{connected ? "Collector healthy" : "Setup required"}</strong><small>Poll interval: 10 seconds</small></div>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <button className="menu-button" onClick={() => setMobileNav(true)} aria-label="Open navigation"><Menu size={21} /></button>
          <div><strong>Local monitoring server</strong><small>{typeof window === "undefined" ? "localhost" : window.location.hostname}</small></div>
          <div className="top-status">
            <span className={`server-chip ${health?.mongo.connected ? "good" : "bad"}`}><Database size={15} /> MongoDB</span>
            <span className={`server-chip ${health?.collector.configured ? "good" : "bad"}`}><Server size={15} /> ZKBio</span>
            <span className="avatar"><CircleUserRound size={19} /></span>
          </div>
        </header>

        <div className="content">
          {(apiError || health?.collector.configurationIssue || health?.collector.lastError) && (
            <div className="notice" role="status">
              <AlertTriangle size={19} />
              <div>
                <strong>{apiError || health?.collector.configurationIssue || "ZKBio connection issue"}</strong>
                <span>{health?.collector.lastError || "Update .env with your MongoDB and ZKBio connection, then restart the app."}</span>
              </div>
            </div>
          )}

          {view === "live" && (
            <section>
              <div className="page-heading"><div><p className="eyebrow"><Radio size={14} /> Live</p><h1>Access activity</h1><p>Scans, physical door openings, and alarms from ZKBio CVSecurity.</p></div><div className="last-sync">Last successful poll<strong>{formatTime(health?.collector.lastSuccessAt)}</strong></div></div>
              <div className="metric-grid">
                <article className="metric"><span className="metric-icon green"><Wifi size={19} /></span><div><small>Doors online</small><strong>{dashboard.onlineDoors} / {dashboard.totalDoors}</strong><p>{Math.max(0, dashboard.totalDoors - dashboard.onlineDoors)} offline</p></div></article>
                <article className="metric"><span className="metric-icon blue"><DoorOpen size={19} /></span><div><small>Open now</small><strong>{dashboard.openDoors}</strong><p>Physical sensor state</p></div></article>
                <article className="metric"><span className="metric-icon purple"><ScanFace size={19} /></span><div><small>Scans today</small><strong>{dashboard.scansToday}</strong><p>{dashboard.deniedToday} denied</p></div></article>
                <article className="metric"><span className="metric-icon amber"><ShieldAlert size={19} /></span><div><small>Active alerts</small><strong>{dashboard.activeAlerts}</strong><p>{dashboard.pendingUploads} awaiting upload</p></div></article>
              </div>

              <div className="monitor-grid">
                <div className="panel">
                  <div className="panel-heading"><div><strong>Recent activity</strong><span>Newest events appear automatically</span></div><span className="live-badge"><span />Live</span></div>
                  <EventTable events={events.slice(0, 25)} onSelect={setSelected} loading={loading} />
                </div>
                <EventDetail event={selected} />
              </div>
            </section>
          )}

          {view === "doors" && (
            <section>
              <div className="page-heading"><div><p className="eyebrow"><DoorClosed size={14} /> Hardware</p><h1>Doors</h1><p>Current connection, sensor, relay, and alarm status.</p></div></div>
              {doors.length ? <div className="door-grid">{doors.map((door) => <DoorCard door={door} key={door._id} />)}</div> : <EmptyState icon={DoorClosed} title="No doors received yet" text="Doors will appear after the first successful ZKBio polling cycle." />}
            </section>
          )}

          {view === "events" && (
            <section>
              <div className="page-heading"><div><p className="eyebrow"><History size={14} /> Archive</p><h1>Event history</h1><p>Search all scans, openings, denials, and alarms saved in MongoDB.</p></div></div>
              <div className="panel">
                <div className="filters">
                  <label className="search-box"><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search person, PIN, card, or door" /></label>
                  <label className="select-box"><Filter size={16} /><select value={resultFilter} onChange={(event) => setResultFilter(event.target.value)}><option value="all">All results</option><option value="granted">Granted</option><option value="denied">Denied</option><option value="warning">Warnings</option><option value="critical">Critical</option></select></label>
                </div>
                <EventTable events={visibleEvents} onSelect={setSelected} loading={loading} showDate />
              </div>
            </section>
          )}

          {view === "system" && (
            <section>
              <div className="page-heading"><div><p className="eyebrow"><Settings2 size={14} /> Operations</p><h1>System health</h1><p>MongoDB, ZKBio polling, and remote delivery status.</p></div></div>
              <div className="health-grid">
                <HealthPanel
                  title="MongoDB"
                  good={Boolean(health?.mongo.connected)}
                  rows={[
                    ["Connection", health?.mongo.connected ? "Connected" : "Disconnected"],
                    ["Database", health?.mongo.database || "doorwatch"],
                    ["Connected at", formatDateTime(health?.mongo.connectedAt)],
                  ]}
                />
                <HealthPanel
                  title="ZKBio collector"
                  good={Boolean(health?.collector.configured && !health?.collector.lastError)}
                  rows={[
                    ["Polling", `Every ${(health?.collector.pollIntervalMs || 10_000) / 1000} seconds`],
                    ["Last success", formatDateTime(health?.collector.lastSuccessAt)],
                    ["Response time", health?.collector.lastDurationMs != null ? `${health.collector.lastDurationMs} ms` : "—"],
                    ["Events saved", String(health?.collector.eventsInserted || 0)],
                  ]}
                />
                <HealthPanel
                  title="Central forwarding"
                  good={Boolean(health?.collector.centralForwarding) || dashboard.pendingUploads === 0}
                  rows={[
                    ["Mode", health?.collector.centralForwarding ? "Remote forwarding enabled" : "Local storage only"],
                    ["Pending events", String(dashboard.pendingUploads)],
                    ["Collector API", `${apiBase().replace("/api", "")}`],
                  ]}
                />
                <div className="panel setup-panel">
                  <div className="panel-heading"><div><strong>Configuration</strong><span>Secrets remain on this machine</span></div><Settings2 size={18} /></div>
                  <ol><li>Open the Settings screen.</li><li>Enter the ZKBio server URL and API token.</li><li>Save and confirm the connection test succeeds.</li></ol>
                </div>
              </div>
            </section>
          )}

          {view === "settings" && (
            <section>
              <div className="page-heading"><div><p className="eyebrow"><Settings2 size={14} /> Administration</p><h1>ZKBio settings</h1><p>Configure the local collector without editing environment files.</p></div></div>
              <form className="settings-grid" onSubmit={saveSettings}>
                <div className="panel settings-panel">
                  <div className="panel-heading"><div><strong>Connection</strong><span>ZKBio CVSecurity server credentials</span></div><Server size={18} /></div>
                  <div className="settings-fields">
                    <label className="form-field"><span>Server URL</span><input type="url" required value={settingsForm.baseUrl} onChange={(event) => setSettingsForm((current) => ({ ...current, baseUrl: event.target.value }))} placeholder="https://192.168.1.100:8088" /><small>Include http:// or https:// and the ZKBio port.</small></label>
                    <label className="form-field"><span>API access token</span><div className="password-field"><KeyRound size={17} /><input type="password" value={settingsForm.accessToken} onChange={(event) => setSettingsForm((current) => ({ ...current, accessToken: event.target.value }))} autoComplete="new-password" placeholder={savedSettings?.accessTokenConfigured ? "Token saved — leave blank to keep it" : "Enter the API token"} /></div><small>The token is encrypted before it is stored.</small></label>
                    <label className="switch-row"><input type="checkbox" checked={settingsForm.enabled} onChange={(event) => setSettingsForm((current) => ({ ...current, enabled: event.target.checked }))} /><span><strong>Enable background collector</strong><small>Poll transactions and door state continuously.</small></span></label>
                  </div>
                </div>

                <div className="panel settings-panel">
                  <div className="panel-heading"><div><strong>Collector behavior</strong><span>Safe polling and network options</span></div><Activity size={18} /></div>
                  <div className="settings-fields two-column">
                    <label className="form-field"><span>Polling interval</span><select value={settingsForm.pollIntervalMs} onChange={(event) => setSettingsForm((current) => ({ ...current, pollIntervalMs: Number(event.target.value) }))}><option value={10000}>Every 10 seconds</option><option value={15000}>Every 15 seconds</option><option value={30000}>Every 30 seconds</option><option value={60000}>Every 60 seconds</option></select><small>10 seconds matches the vendor recommendation.</small></label>
                    <label className="form-field"><span>Request timeout</span><select value={settingsForm.timeoutMs} onChange={(event) => setSettingsForm((current) => ({ ...current, timeoutMs: Number(event.target.value) }))}><option value={5000}>5 seconds</option><option value={8000}>8 seconds</option><option value={15000}>15 seconds</option><option value={30000}>30 seconds</option></select><small>How long to wait for each ZKBio response.</small></label>
                    <label className="switch-row full"><input type="checkbox" checked={settingsForm.allowInsecureTls} onChange={(event) => setSettingsForm((current) => ({ ...current, allowInsecureTls: event.target.checked }))} /><span><strong>Allow self-signed HTTPS certificate</strong><small>Enable only when your local ZKBio server uses a certificate your computer does not trust.</small></span></label>
                  </div>
                </div>

                <div className="panel settings-actions">
                  <div className="security-note"><LockKeyhole size={20} /><div><strong>Protected configuration</strong><p>The token is never returned to the browser after saving. Anyone who can access this Settings page can change the connection, so keep DoorWatch on a trusted LAN.</p></div></div>
                  {settingsMessage ? <div className={`settings-result ${settingsMessage.tone}`} role="status">{settingsMessage.tone === "success" ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />}<span>{settingsMessage.text}</span></div> : null}
                  <div className="save-row"><span>{savedSettings?.updatedAt ? `Last updated ${formatDateTime(savedSettings.updatedAt)}` : "Not configured yet"}</span><button type="submit" disabled={settingsSaving}>{settingsSaving ? "Saving and testing…" : "Save and test connection"}</button></div>
                </div>
              </form>

              <form className="panel webhook-settings" onSubmit={saveWebhook}>
                <div className="panel-heading"><div><strong>Outbound webhook</strong><span>POST completed access events to another server</span></div><Webhook size={19} /></div>
                <div className="webhook-body">
                  <div className="webhook-fields">
                    <label className="switch-row full"><input type="checkbox" checked={webhookForm.enabled} onChange={(event) => setWebhookForm((current) => ({ ...current, enabled: event.target.checked }))} /><span><strong>Enable webhook delivery</strong><small>Send only after a valid scan is matched to a physical door opening.</small></span></label>
                    <label className="form-field full"><span>Destination URL or template</span><input type="text" inputMode="url" required={webhookForm.enabled} value={webhookForm.url} onChange={(event) => setWebhookForm((current) => ({ ...current, url: event.target.value }))} placeholder={"https://example.com/events/{{person.pin}}"} /><small>Use a fixed URL, or insert <code>{"{{id}}"}</code>, <code>{"{{person.pin}}"}</code>, <code>{"{{person.cardNumber}}"}</code>, <code>{"{{door.id}}"}</code>, <code>{"{{door.name}}"}</code>, <code>{"{{device.serialNumber}}"}</code>, or <code>{"{{collectorId}}"}</code>. The full event is still sent as POST JSON.</small></label>
                    <label className="form-field"><span>Bearer token</span><div className="password-field"><KeyRound size={17} /><input type="password" value={webhookForm.secret} onChange={(event) => setWebhookForm((current) => ({ ...current, secret: event.target.value }))} autoComplete="new-password" placeholder={savedWebhook?.secretConfigured ? "Token saved — leave blank to keep it" : "Optional authorization token"} /></div><small>Sent as <code>Authorization: Bearer …</code> and stored encrypted.</small></label>
                    <label className="form-field"><span>Request timeout</span><select value={webhookForm.timeoutMs} onChange={(event) => setWebhookForm((current) => ({ ...current, timeoutMs: Number(event.target.value) }))}><option value={5000}>5 seconds</option><option value={8000}>8 seconds</option><option value={15000}>15 seconds</option><option value={30000}>30 seconds</option></select><small>Failed requests retry automatically up to 10 times.</small></label>
                  </div>
                  <aside className="webhook-summary">
                    <span className="webhook-icon"><Send size={21} /></span>
                    <strong>POST event</strong>
                    <code>access.granted_opened</code>
                    <dl><div><dt>Pending</dt><dd>{webhookStatus.pending || 0}</dd></div><div><dt>Retrying</dt><dd>{webhookStatus.retrying || 0}</dd></div><div><dt>Delivered</dt><dd>{webhookStatus.delivered || 0}</dd></div><div><dt>Failed</dt><dd>{webhookStatus.failed || 0}</dd></div></dl>
                  </aside>
                </div>
                {webhookMessage ? <div className={`settings-result webhook-result ${webhookMessage.tone}`} role="status">{webhookMessage.tone === "success" ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />}<span>{webhookMessage.text}</span></div> : null}
                <div className="save-row webhook-save"><span>{savedWebhook?.updatedAt ? `Last updated ${formatDateTime(savedWebhook.updatedAt)}` : "Not configured yet"}</span><button type="submit" disabled={webhookSaving}>{webhookSaving ? "Saving and testing…" : "Save and send test POST"}</button></div>
              </form>
            </section>
          )}
        </div>
      </main>
    </div>
  );
}

function EventTable({ events, onSelect, loading, showDate = false }: { events: DoorEvent[]; onSelect: (event: DoorEvent) => void; loading: boolean; showDate?: boolean }) {
  if (loading) return <div className="loading-row"><span />Loading monitoring data…</div>;
  if (!events.length) return <EmptyState icon={Activity} title="No events yet" text="New ZKBio transactions and door changes will appear here." compact />;
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>{showDate ? "Date & time" : "Time"}</th><th>Person / credential</th><th>Door</th><th>Method</th><th>Result</th><th>Delivery</th></tr></thead>
        <tbody>{events.map((event) => (
          <tr key={event._id} onClick={() => onSelect(event)}>
            <td className="nowrap">{showDate ? formatDateTime(event.eventTime) : formatTime(event.eventTime)}</td>
            <td><strong>{event.personName || (event.personPin ? `PIN ${event.personPin}` : event.cardNumber ? `Card ${event.cardNumber}` : "System event")}</strong>{event.personName && event.personPin ? <small>PIN {event.personPin}</small> : null}</td>
            <td>{event.doorName || "—"}</td>
            <td>{event.verificationMode || "—"}</td>
            <td><span className={`status ${statusTone(event)}`}>{eventLabel(event)}</span></td>
            <td><span className="delivery">{event.delivery?.status?.replaceAll("_", " ") || "local"}</span></td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function EventDetail({ event }: { event: DoorEvent | null }) {
  return (
    <aside className="panel event-detail">
      <div className="panel-heading"><div><strong>Event detail</strong><span>Selected activity</span></div>{event ? <span className={`status ${statusTone(event)}`}>{eventLabel(event)}</span> : null}</div>
      {event ? <div className="detail-body"><span className="detail-icon"><ScanFace size={22} /></span><h2>{event.personName || event.personPin || event.cardNumber || "System event"}</h2><p>{formatDateTime(event.eventTime)}</p><dl><div><dt>Door</dt><dd>{event.doorName || "—"}</dd></div><div><dt>Verification</dt><dd>{event.verificationMode || "—"}</dd></div><div><dt>Reader</dt><dd>{event.readerName || "—"}</dd></div><div><dt>Sensor</dt><dd>{event.sensorState || "—"}</dd></div><div><dt>Alarm</dt><dd>{event.alarmState || "None"}</dd></div></dl></div> : <EmptyState icon={Activity} title="Select an event" text="Choose an activity row to inspect its details." compact />}
    </aside>
  );
}

function DoorCard({ door }: { door: Door }) {
  const online = door.connect === "1" || door.connect === "online";
  const alarming = !["none", "unknown", ""].includes(door.alarm);
  return <article className="door-card"><div className="door-card-top"><span className={`door-icon ${alarming ? "alarm" : ""}`}>{door.sensor === "open" ? <DoorOpen size={20} /> : <DoorClosed size={20} />}</span><span className={`status ${alarming ? "danger" : online ? "success" : "warning"}`}>{alarming ? "Alarm" : online ? "Online" : "Offline"}</span></div><h2>{door.name || door.doorId}</h2><p>{door.deviceId || "No device identifier"}</p><div className="door-states"><div><small>Sensor</small><strong>{door.sensor.replaceAll("_", " ")}</strong></div><div><small>Relay</small><strong>{door.relay}</strong></div><div><small>Alarm</small><strong>{door.alarm.replaceAll("_", " ")}</strong></div><div><small>Checked</small><strong>{formatTime(door.checkedAt)}</strong></div></div></article>;
}

function HealthPanel({ title, good, rows }: { title: string; good: boolean; rows: string[][] }) {
  return <div className="panel health-panel"><div className="panel-heading"><div><strong>{title}</strong><span>{good ? "Operating normally" : "Needs attention"}</span></div>{good ? <CheckCircle2 className="health-good" size={20} /> : <WifiOff className="health-bad" size={20} />}</div><dl>{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></div>;
}

function EmptyState({ icon: Icon, title, text, compact = false }: { icon: typeof Activity; title: string; text: string; compact?: boolean }) {
  return <div className={`empty ${compact ? "compact" : ""}`}><Icon size={25} /><strong>{title}</strong><p>{text}</p></div>;
}
