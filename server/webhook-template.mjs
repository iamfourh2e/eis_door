export const WEBHOOK_URL_FIELDS = Object.freeze([
  "id",
  "collectorId",
  "person.pin",
  "person.cardNumber",
  "door.id",
  "door.name",
  "device.serialNumber",
]);

const fields = new Set(WEBHOOK_URL_FIELDS);
const placeholderPattern = /\{\{([a-zA-Z][a-zA-Z0-9.]*)\}\}/g;

function authority(template) {
  const schemeEnd = template.indexOf("://");
  if (schemeEnd === -1) return template;
  const rest = template.slice(schemeEnd + 3);
  const boundary = rest.search(/[/?#]/);
  return boundary === -1 ? rest : rest.slice(0, boundary);
}

function valueAt(payload, path) {
  return path.split(".").reduce((value, part) => value?.[part], payload);
}

export function validateWebhookTemplate(value) {
  const template = String(value ?? "").trim().replace(/\/+$/, "");
  if (!template) return "";
  if (authority(template).includes("{{") || authority(template).includes("}}")) {
    throw new Error("Webhook placeholders are allowed only in the URL path, query, or fragment");
  }
  const rendered = template.replace(placeholderPattern, (_match, path) => {
    if (!fields.has(path)) throw new Error(`Unsupported webhook URL field: {{${path}}}`);
    return "sample";
  });
  if (rendered.includes("{{") || rendered.includes("}}")) {
    throw new Error("Webhook URL contains an invalid placeholder");
  }
  let url;
  try {
    url = new URL(rendered);
  } catch {
    throw new Error("Webhook URL is invalid");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Webhook URL must use http:// or https://");
  }
  return template;
}

export function resolveWebhookUrl(value, payload) {
  const template = validateWebhookTemplate(value);
  if (!template) throw new Error("Webhook URL is required");
  return template.replace(placeholderPattern, (_match, path) => {
    const fieldValue = valueAt(payload, path);
    if (fieldValue === null || fieldValue === undefined || fieldValue === "") {
      throw new Error(`Webhook URL field {{${path}}} is missing from this event`);
    }
    return encodeURIComponent(String(fieldValue));
  });
}
