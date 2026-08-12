// Remote MCP entry: serves the same Akari Health MCP over Streamable HTTP for
// claude.ai / ChatGPT custom connectors. Bound to loopback; a Cloudflare Tunnel
// provides TLS and the public hostname. Access control is a long random URL path
// (connector UIs cannot send custom headers without OAuth); rotate it by changing
// AKARI_MCP_HTTP_PATH and updating the connector URL.
import http from "node:http";
import { Readable } from "node:stream";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { createMcpServer } from "./server.js";

const host = process.env.AKARI_MCP_HTTP_HOST || "127.0.0.1";
const port = Number(process.env.AKARI_MCP_HTTP_PORT || "28788");
const mcpPath = process.env.AKARI_MCP_HTTP_PATH || "";

if (!/^\/mcp\/[A-Za-z0-9_-]{32,}$/.test(mcpPath)) {
  console.error(
    "AKARI_MCP_HTTP_PATH must look like /mcp/<random token of at least 32 url-safe characters>"
  );
  process.exit(1);
}

const handler = createMcpHandler(() => createMcpServer());

function toWebRequest(request) {
  const url = `http://${host}:${port}${request.url}`;
  const init = {
    method: request.method,
    headers: request.headers,
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = Readable.toWeb(request);
    init.duplex = "half";
  }
  return new Request(url, init);
}

async function writeWebResponse(webResponse, response) {
  const headers = {};
  webResponse.headers.forEach((value, key) => {
    headers[key] = value;
  });
  response.writeHead(webResponse.status, headers);
  if (webResponse.body) {
    for await (const chunk of webResponse.body) {
      response.write(chunk);
    }
  }
  response.end();
}

const server = http.createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url || "/", "http://mcp.local").pathname;
    if (request.method === "GET" && pathname === "/healthz") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ ok: true, service: "akari-health-mcp-http", status: "PASS", generated_at: Date.now() })
      );
      return;
    }
    if (pathname !== mcpPath) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: false, error: { code: "NOT_FOUND", message: "route is not supported" } }));
      return;
    }
    await writeWebResponse(await handler.fetch(toWebRequest(request)), response);
  } catch (error) {
    console.error("akari-health MCP http error", error);
    if (!response.headersSent) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: false, error: { code: "INTERNAL", message: "unexpected error" } }));
    } else {
      response.end();
    }
  }
});

server.listen(port, host, () => {
  console.error(`akari-health MCP listening on http://${host}:${port}${mcpPath}`);
});

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.error(`akari-health MCP http received ${signal}; closing`);
  await handler.close();
  server.close(() => {
    process.exitCode = 0;
  });
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
