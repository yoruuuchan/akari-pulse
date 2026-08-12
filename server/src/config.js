import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));

function isLoopbackHost(host) {
  return host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

export function loadConfig(env = process.env) {
  const host = env.AKARI_HEALTH_HOST || "127.0.0.1";
  const rawPort = env.AKARI_HEALTH_PORT || "8787";
  if (!/^\d+$/.test(rawPort)) throw new Error("AKARI_HEALTH_PORT must be an integer");
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("AKARI_HEALTH_PORT must be between 0 and 65535");
  }

  const token = env.AKARI_HEALTH_TOKEN || "";
  if (!isLoopbackHost(host) && token.length === 0) {
    throw new Error("AKARI_HEALTH_TOKEN is required when AKARI_HEALTH_HOST is not loopback");
  }

  const defaultDatabasePath = path.resolve(moduleDirectory, "..", "data", "akari-health.sqlite");
  const databasePath = env.AKARI_HEALTH_DB
    ? path.resolve(env.AKARI_HEALTH_DB)
    : defaultDatabasePath;

  return {
    host,
    port,
    token,
    databasePath,
    maxBodyBytes: 1024 * 1024,
  };
}

export { isLoopbackHost };
