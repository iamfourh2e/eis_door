const baseUrl = String(process.env.ZKBIO_SIMULATOR_URL || "").replace(/\/+$/, "");
const accessToken = process.env.ZKBIO_SIMULATOR_TOKEN || "demo-token";

export function simulatorConfiguration() {
  return { available: Boolean(baseUrl), baseUrl, accessToken };
}

export async function simulatorRequest(path, body) {
  if (!baseUrl) throw new Error("ZKBio simulator is not available");
  const response = await fetch(`${baseUrl}/simulator/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Simulator returned HTTP ${response.status}`);
  return result;
}
