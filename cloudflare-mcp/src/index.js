/**
 * Cloudflare Worker + Sandbox 1.0 MCP Server for 8-V-Org/tools_SkillEvaluator
 * Protocol: Model Context Protocol (MCP) JSON-RPC 2024-11-05 over HTTP/POST
 */

import { Files } from "@cloudflare/sandbox";
import { DurableObject } from "cloudflare:workers";

const SERVER_NAME = "tools-skillevaluator";
const SERVER_VERSION = "1.0.0";
const PROTOCOL_VERSION = "2024-11-05";

export class SkillEvaluatorSandbox extends DurableObject {
  container;
  files;

  constructor(ctx, env) {
    super(ctx, env);
    if (!ctx.container) {
      throw new Error("No container is configured on SkillEvaluatorSandbox");
    }
    this.container = ctx.container;
    this.files = new Files(ctx.container);
  }

  ensureRunning(enableInternet = true) {
    if (!this.container.running) {
      this.container.start({
        image: this.container.images.base,
        instance: "standard-1",
        enableInternet
      });
    }
  }

  async runValidate({ repo_url, branch, skill_subpath, inline_files, tiers }) {
    this.ensureRunning(true);
    await this.container.exec(["rm", "-rf", "/workspace/target", "/workspace/reports"]);
    await this.container.exec(["mkdir", "-p", "/workspace/target", "/workspace/reports"]);

    if (repo_url) {
      const cloneArgs = ["git", "clone", "--depth", "1"];
      if (branch) cloneArgs.push("-b", branch);
      cloneArgs.push(repo_url, "/workspace/target");
      const cloneProc = await this.container.exec(cloneArgs);
      const cloneOut = await cloneProc.output();
      if (cloneProc.exitCode !== undefined && cloneProc.exitCode !== 0) {
        throw new Error(`git clone failed (exit ${cloneProc.exitCode}): ${cloneOut}`);
      }
    } else if (inline_files && typeof inline_files === "object") {
      for (const [relPath, content] of Object.entries(inline_files)) {
        const cleanRel = relPath.replace(/^\/+/, "").replace(/\.\./g, "_");
        const fullPath = `/workspace/target/${cleanRel}`;
        const dir = fullPath.split("/").slice(0, -1).join("/");
        if (dir) await this.container.exec(["mkdir", "-p", dir]);
        await this.files.writeFile(fullPath, String(content));
      }
    } else {
      throw new Error("Either 'repo_url' or 'inline_files' must be provided.");
    }

    const cleanSub = skill_subpath ? `/${skill_subpath.replace(/^\/+/, "").replace(/\.\./g, "_")}` : "";
    const targetPath = `/workspace/target${cleanSub}`;

    const envArgs = [];
    if (this.env.NVIDIA_API_KEY) envArgs.push(`NVIDIA_API_KEY=${this.env.NVIDIA_API_KEY}`);
    if (this.env.OPENAI_API_KEY) envArgs.push(`OPENAI_API_KEY=${this.env.OPENAI_API_KEY}`);
    if (this.env.ANTHROPIC_API_KEY) envArgs.push(`ANTHROPIC_API_KEY=${this.env.ANTHROPIC_API_KEY}`);

    const cmd = [
      ...(envArgs.length ? ["env", ...envArgs] : []),
      "skillevaluator",
      "validate",
      targetPath,
      "--tiers",
      tiers,
      "-r",
      "json",
      "--output-dir",
      "/workspace/reports"
    ];

    const proc = await this.container.exec(cmd);
    const stdout = await proc.output();

    const listProc = await this.container.exec([
      "sh",
      "-c",
      "find /workspace/reports -maxdepth 3 -name '*.json' -print"
    ]);
    const reportPaths = (await listProc.output())
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);

    const reports = {};
    for (const rp of reportPaths.slice(0, 5)) {
      try {
        const r = await this.files.readFile(rp);
        const text = typeof r === "string" ? r : r?.content ?? "";
        reports[rp] = JSON.parse(text);
      } catch {
        // ignore unreadable/non-json files
      }
    }

    return {
      exit_code: proc.exitCode ?? 0,
      target: targetPath,
      tiers,
      reports,
      stdout
    };
  }
}

const TOOLS = [
  {
    name: "validate_tier1",
    description:
      "Run SkillEvaluator Tier 1 static validation, quality gates, PII/security scanning (bandit) on a GitHub repo or inline skill files (no LLM key required).",
    inputSchema: {
      type: "object",
      properties: {
        repo_url: {
          type: "string",
          description: "HTTPS Git repository URL containing the skill(s)."
        },
        branch: {
          type: "string",
          description: "Optional branch or ref."
        },
        skill_subpath: {
          type: "string",
          description: "Optional subdirectory inside the repo (e.g. 'skills/my-skill')."
        },
        inline_files: {
          type: "object",
          description: "Alternative to repo_url: map of relative file paths (e.g. 'SKILL.md') to file contents."
        }
      }
    }
  },
  {
    name: "validate",
    description:
      "Run SkillEvaluator Tiers 1 and 2 (static + security + LLM/embedding deduplication) on a GitHub repo or inline skill files.",
    inputSchema: {
      type: "object",
      properties: {
        repo_url: {
          type: "string",
          description: "HTTPS Git repository URL containing the skill(s)."
        },
        branch: {
          type: "string",
          description: "Optional branch or ref."
        },
        skill_subpath: {
          type: "string",
          description: "Optional subdirectory inside the repo."
        },
        inline_files: {
          type: "object",
          description: "Alternative to repo_url: map of relative file paths to file contents."
        },
        tiers: {
          type: "string",
          description: "Comma-separated tiers to run (default: '1,2')."
        }
      }
    }
  },
  {
    name: "status",
    description: "Returns health telemetry for the tools-skillevaluator MCP server.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  }
];

async function dispatchTool(name, args, env) {
  switch (name) {
    case "validate_tier1": {
      const sessionId = crypto.randomUUID();
      const stub = env.SANDBOX.get(env.SANDBOX.idFromName(sessionId));
      const res = await stub.runValidate({ ...(args || {}), tiers: "1" });
      return JSON.stringify(res, null, 2);
    }
    case "validate": {
      const sessionId = crypto.randomUUID();
      const stub = env.SANDBOX.get(env.SANDBOX.idFromName(sessionId));
      const res = await stub.runValidate({ ...(args || {}), tiers: args?.tiers || "1,2" });
      return JSON.stringify(res, null, 2);
    }
    case "status":
      return JSON.stringify({
        server: SERVER_NAME,
        version: SERVER_VERSION,
        protocol: PROTOCOL_VERSION,
        status: "healthy",
        timestamp: new Date().toISOString()
      }, null, 2);
    default:
      throw new Error(`Unknown tool: '${name}'`);
  }
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key, X-Requested-With",
  "Content-Type": "application/json"
};

function jsonRpcSuccess(id, result) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function jsonRpcError(id, code, message, data = undefined) {
  const err = { code, message };
  if (data !== undefined) err.data = data;
  return { jsonrpc: "2.0", id: id ?? null, error: err };
}

async function processRpcRequest(req, env) {
  if (!req || typeof req !== "object" || req.jsonrpc !== "2.0" || !req.method) {
    return jsonRpcError(req?.id, -32600, "Invalid Request");
  }

  const { id, method, params } = req;

  try {
    switch (method) {
      case "initialize":
        return jsonRpcSuccess(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION }
        });

      case "notifications/initialized":
      case "ping":
        return jsonRpcSuccess(id, {});

      case "tools/list":
        return jsonRpcSuccess(id, { tools: TOOLS });

      case "tools/call": {
        const toolName = params?.name;
        const toolArgs = params?.arguments || {};
        if (!toolName) {
          return jsonRpcError(id, -32602, "Invalid params: 'name' is required");
        }
        try {
          const textResult = await dispatchTool(toolName, toolArgs, env);
          return jsonRpcSuccess(id, {
            content: [{ type: "text", text: textResult }],
            isError: false
          });
        } catch (toolErr) {
          return jsonRpcSuccess(id, {
            content: [{ type: "text", text: `Error executing '${toolName}': ${toolErr.message}` }],
            isError: true
          });
        }
      }

      default:
        return jsonRpcError(id, -32601, `Method not found: '${method}'`);
    }
  } catch (err) {
    return jsonRpcError(id, -32603, "Internal error", err.message);
  }
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const expectedToken = env.PORTAL_AUTH_TOKEN;
    if (expectedToken) {
      const auth = request.headers.get("authorization") || "";
      const apiKey = request.headers.get("x-api-key") || "";
      if (auth !== `Bearer ${expectedToken}` && apiKey !== expectedToken) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: corsHeaders
        });
      }
    }

    if (request.method === "GET") {
      return new Response(
        JSON.stringify(
          {
            status: "active",
            service: SERVER_NAME,
            version: SERVER_VERSION,
            protocol: `Model Context Protocol (MCP) JSON-RPC ${PROTOCOL_VERSION}`,
            available_tools: TOOLS.map((t) => t.name)
          },
          null,
          2
        ),
        { status: 200, headers: corsHeaders }
      );
    }

    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
        status: 405,
        headers: corsHeaders
      });
    }

    let body;
    try {
      body = await request.json();
    } catch (parseErr) {
      return new Response(JSON.stringify(jsonRpcError(null, -32700, "Parse error", parseErr.message)), {
        status: 400,
        headers: corsHeaders
      });
    }

    if (Array.isArray(body)) {
      const responses = await Promise.all(body.map((req) => processRpcRequest(req, env)));
      return new Response(JSON.stringify(responses), { status: 200, headers: corsHeaders });
    }

    const result = await processRpcRequest(body, env);
    return new Response(JSON.stringify(result), { status: 200, headers: corsHeaders });
  }
};
