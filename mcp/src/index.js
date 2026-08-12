import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createMcpServer } from "./server.js";

try {
  const handle = serveStdio(() => createMcpServer(), {
    onerror: (error) => console.error("akari-health MCP transport error", error),
  });
  console.error("akari-health MCP listening on stdio");

  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    console.error(`akari-health MCP received ${signal}; closing`);
    await handle.close();
    process.exitCode = 0;
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
} catch (error) {
  console.error("akari-health MCP failed to start", error);
  process.exitCode = 1;
}
