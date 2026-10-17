// Starts the built server over stdio and returns its tools/list result.
//
// Used by scripts/generate-readme-tools.mjs and tests/tool-annotations.test.mjs,
// so the README tables and the annotation test both read what a real MCP client
// receives on the wire, not what the source happens to say.
//
// The child runs with HOME pointed at a fresh temp directory so startup reads
// (task store, agora feed) and the nullifier directory never touch the real
// home directory, and with APS_PROFILE=full so every tool is listed.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("../../build/index.js", import.meta.url));

export async function listToolsOverStdio({ timeoutMs = 30000 } = {}) {
  const home = mkdtempSync(join(tmpdir(), "aps-mcp-list-"));
  const env = { ...process.env, HOME: home, APS_PROFILE: "full" };
  delete env.MCP_REMOTE;
  delete env.MCP_TRANSPORT;
  const child = spawn(process.execPath, [SERVER], { env, stdio: ["pipe", "pipe", "pipe"] });

  let buf = "";
  const pending = new Map();
  let nextId = 1;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.code}: ${msg.error.message}`));
        else resolve(msg.result);
      }
    }
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c) => { stderr += c; });

  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });

  const timer = setTimeout(() => {
    for (const { reject } of pending.values()) reject(new Error(`timed out; server stderr:\n${stderr}`));
    pending.clear();
  }, timeoutMs);

  try {
    await request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "aps-mcp-list-tools", version: "0" },
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const tools = [];
    let cursor;
    do {
      const res = await request("tools/list", cursor ? { cursor } : {});
      tools.push(...res.tools);
      cursor = res.nextCursor;
    } while (cursor);
    return tools;
  } finally {
    clearTimeout(timer);
    child.kill();
    rmSync(home, { recursive: true, force: true });
  }
}
