import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

function createServer() {
  const server = new McpServer({
    name: "Publisher HTML5 Agent Uploader",
    version: "0.1.0",
  });

  server.registerTool(
    "health_check",
    {
      description:
        "Verify that the Publisher HTML5 Agent MCP bridge is online and reachable.",
      inputSchema: z.object({
        message: z.string().optional(),
      }),
    },
    async ({ message }) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            service: "publisher-creatives-uploader",
            message: message ?? "MCP bridge is online",
          }),
        },
      ],
    }),
  );

  server.registerTool(
    "validate_publish_request",
    {
      description:
        "Validate the metadata for a publisher creative before files are uploaded. This tool does not publish yet.",
      inputSchema: z.object({
        client: z.string().min(1),
        campaign: z.string().min(1),
        publisher: z.string().min(1),
        creative_name: z.string().min(1),
        landing_url: z.string().url(),
        creative_count: z.number().int().positive(),
      }),
    },
    async (input) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            stage: "validation-only",
            ...input,
            targetPath: [input.client, input.campaign, input.publisher, input.creative_name].join("/"),
          }),
        },
      ],
    }),
  );

  return server;
}

const handler = createMcpHandler(createServer, {
  route: "/mcp",
  responseMode: "auto",
});

export default {
  async fetch(request: Request, env: unknown, ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response(
        JSON.stringify({
          ok: true,
          service: "publisher-creatives-uploader",
          mcp: "/mcp",
          version: "0.1.0",
        }),
        {
          headers: { "content-type": "application/json; charset=utf-8" },
        },
      );
    }

    return handler(request, env, ctx);
  },
} satisfies ExportedHandler;
