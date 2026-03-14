// ─────────────────────────────────────────────────────────────────────────────
// kt-platform/mcp-bridge.js
//
// HTTP-to-stdio bridge for the GitHub MCP server.
// Wraps @modelcontextprotocol/server-github (stdio) and exposes it as HTTP
// so the GitHub connector can call it at http://localhost:3002.
//
// Exposes:
//   GET  /health        → { status: "ok" | "starting" }
//   POST /tools/call    → JSON-RPC 2.0 forward to MCP server
//
// Usage:
//   node mcp-bridge.js
//
// Requires GITHUB_TOKEN in .env (same file as server.js).
// ─────────────────────────────────────────────────────────────────────────────

import express from "express";
import { spawn } from "child_process";
import { createInterface } from "readline";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, ".env") });

const PORT         = parseInt(process.env.MCP_BRIDGE_PORT || "3002");
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || process.env.GITHUB_PERSONAL_ACCESS_TOKEN;

if (!GITHUB_TOKEN) {
  console.error("❌  GITHUB_TOKEN not set in .env — cannot start MCP bridge.");
  console.error("    Add GITHUB_TOKEN=ghp_xxx to kt-platform/.env and restart.");
  process.exit(1);
}

// ── MCP stdio state ───────────────────────────────────────────────────────────

let mcpProc     = null;
let initialized = false;
const pending   = new Map();   // id → { resolve, reject, timer }
let nextId      = 1;

function writeMcp(msg) {
  if (!mcpProc || mcpProc.exitCode !== null) {
    throw new Error("MCP process is not running");
  }
  mcpProc.stdin.write(JSON.stringify(msg) + "\n");
}

function rpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id    = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`MCP timeout waiting for response to: ${method}`));
    }, 30_000);
    pending.set(id, { resolve, reject, timer });
    writeMcp({ jsonrpc: "2.0", id, method, params });
  });
}

async function initializeMcp() {
  await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities:    { tools: {} },
    clientInfo:      { name: "kt-platform-mcp-bridge", version: "1.0.0" },
  });
  // Send the required "initialized" notification (no id = fire-and-forget)
  writeMcp({ jsonrpc: "2.0", method: "notifications/initialized" });
}

function spawnMcp() {
  console.log("⏳  Spawning @modelcontextprotocol/server-github …");

  const proc = spawn(
    "npx",
    ["--yes", "@modelcontextprotocol/server-github"],
    {
      env: {
        ...process.env,
        GITHUB_PERSONAL_ACCESS_TOKEN: GITHUB_TOKEN,
      },
      stdio: ["pipe", "pipe", "inherit"],
      shell: true,
    }
  );

  // Parse JSON-RPC responses from stdout (newline-delimited)
  const rl = createInterface({ input: proc.stdout });
  rl.on("line", (raw) => {
    const line = raw.trim();
    if (!line) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }

    // Dispatch to a pending request
    if (msg.id != null && pending.has(msg.id)) {
      const { resolve, reject, timer } = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(timer);
      if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else           resolve(msg);
    }

    // Log server-side notifications (e.g. progress)
    if (msg.method) {
      console.log(`[MCP ←] ${msg.method}`);
    }
  });

  proc.on("exit", (code) => {
    console.warn(`⚠️   MCP server process exited (code ${code})`);
    initialized = false;
    mcpProc     = null;
  });

  proc.on("error", (err) => {
    console.error("❌  Failed to spawn MCP server:", err.message);
  });

  return proc;
}

// ── HTTP server ───────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: initialized ? "ok" : "starting" });
});

app.post("/tools/call", async (req, res) => {
  if (!initialized) {
    return res.status(503).json({
      error: { message: "MCP server is still initializing, retry in a moment." },
    });
  }
  try {
    const { params } = req.body;
    const result = await rpc("tools/call", params);
    res.json(result);
  } catch (err) {
    console.error("[/tools/call]", err.message);
    res.status(500).json({ error: { message: err.message } });
  }
});

// ── Startup ───────────────────────────────────────────────────────────────────

mcpProc = spawnMcp();

// Give npx time to download (first run) and the process to boot
setTimeout(async () => {
  try {
    await initializeMcp();
    initialized = true;
    console.log("✅  GitHub MCP server initialized and ready");
    console.log(`    Use keyword "kt-platform-poc" in Agent Studio`);
  } catch (err) {
    console.error("❌  MCP initialization failed:", err.message);
    console.error("    Check GITHUB_TOKEN scopes (needs: repo, read:org)");
  }
}, 3000);

app.listen(PORT, () => {
  console.log(`\n🔌  MCP HTTP Bridge running at http://localhost:${PORT}`);
  console.log(`    GET  /health`);
  console.log(`    POST /tools/call  (JSON-RPC 2.0)\n`);
});
