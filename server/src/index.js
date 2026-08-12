import { loadConfig } from "./config.js";
import { createHealthService } from "./app.js";

async function main() {
  const config = loadConfig();
  const service = createHealthService(config);
  const address = await service.listen();
  const displayHost = typeof address === "object" && address ? address.address : config.host;
  const displayPort = typeof address === "object" && address ? address.port : config.port;
  console.error(`akari-health listening on http://${displayHost}:${displayPort}`);

  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    console.error(`akari-health received ${signal}; closing`);
    await service.close();
    process.exitCode = 0;
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  console.error("akari-health failed to start", error);
  process.exitCode = 1;
});
