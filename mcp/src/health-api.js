export class HealthApiError extends Error {
  constructor(message, { statusCode = null, code = "SERVICE_ERROR", details = undefined } = {}) {
    super(message);
    this.name = "HealthApiError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export class HealthApi {
  constructor({ baseUrl, token = "", timeoutMs = 10000 }) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.token = token;
    this.timeoutMs = timeoutMs;
  }

  async request(path, { method = "GET", body = undefined } = {}) {
    const headers = { accept: "application/json" };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers["content-type"] = "application/json";

    let response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new HealthApiError(`Akari Health service is unreachable: ${error.message}`, {
        code: "SERVICE_UNREACHABLE",
      });
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new HealthApiError(`Akari Health service returned non-JSON HTTP ${response.status}`, {
        statusCode: response.status,
        code: "INVALID_SERVICE_RESPONSE",
      });
    }
    if (!response.ok || payload?.ok !== true) {
      throw new HealthApiError(payload?.error?.message || `Akari Health service returned HTTP ${response.status}`, {
        statusCode: response.status,
        code: payload?.error?.code || "SERVICE_ERROR",
        details: payload?.error?.details,
      });
    }
    return payload;
  }
}

export function loadApiConfig(env = process.env) {
  const rawUrl = env.AKARI_HEALTH_URL || "http://127.0.0.1:8787";
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("AKARI_HEALTH_URL must be an absolute HTTP or HTTPS URL");
  }
  if (!new Set(["http:", "https:"]).has(parsed.protocol)) {
    throw new Error("AKARI_HEALTH_URL must use HTTP or HTTPS");
  }
  const rawTimeout = env.AKARI_HEALTH_TIMEOUT_MS || "10000";
  if (!/^\d+$/.test(rawTimeout)) throw new Error("AKARI_HEALTH_TIMEOUT_MS must be an integer");
  const timeoutMs = Number(rawTimeout);
  if (timeoutMs < 100 || timeoutMs > 120000) {
    throw new Error("AKARI_HEALTH_TIMEOUT_MS must be between 100 and 120000");
  }
  return {
    baseUrl: parsed.toString(),
    token: env.AKARI_HEALTH_TOKEN || "",
    timeoutMs,
  };
}
