#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { parseStatusOutput, statusCountryCode } from "./status-parser.js";

const AUTH_FILE = join(homedir(), ".nord-auth");
const HOMEBREW_BIN = "/opt/homebrew/bin";
const HOMEBREW_SBIN = "/opt/homebrew/sbin";
const COUNTRY_CODE_PATTERN = /^[A-Za-z]{2}$/;
const SERVER_PATTERN = /^[a-z]{2}\d{1,4}(?:\.nordvpn\.com)?$/i;
const STATEFUL_TOOLS = new Set(["vpn_connect", "vpn_disconnect", "vpn_rotate", "vpn_setup"]);
const COMMAND_TIMEOUTS_MS: Record<string, number> = {
  vpn_status: 15_000,
  vpn_list_countries: 30_000,
  vpn_list_servers: 30_000,
  vpn_connect: 120_000,
  vpn_disconnect: 60_000,
  vpn_rotate: 120_000,
  vpn_setup: 120_000,
};

let statefulToolQueue: Promise<void> = Promise.resolve();

const configuredProjectRoot = normalizeProjectRoot(process.argv[2] ?? process.env.NORDVPN_PROJECT_ROOT);
const configuredPythonBin = join(configuredProjectRoot, ".venv", "bin", "python");

type ToolArgs = Record<string, unknown>;

type CliResult = {
  toolName: string;
  command: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
};

type StructuredResult = {
  tool: string;
  success: boolean;
  exitCode: number;
  command?: string[];
  stdout?: string;
  stderr?: string;
  stateChanged?: boolean;
  parsed?: Record<string, unknown>;
  timedOut?: boolean;
  verification?: {
    settledSeconds: number;
    success: boolean;
    reason?: string;
    expectedCountry?: string;
    observedCountry?: string;
    result: Omit<StructuredResult, "verification">;
  };
  error?: string;
};

const TOOLS: Tool[] = [
  {
    name: "vpn_status",
    description: "Show current NordVPN connection state and public IP information.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "vpn_list_countries",
    description: "List available NordVPN countries and their country codes.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "vpn_list_servers",
    description: "List NordVPN servers for a country using a specific protocol.",
    inputSchema: {
      type: "object",
      properties: {
        country: {
          type: "string",
          description: "Two-letter country code, such as US, DE, or JP.",
          pattern: "^[A-Za-z]{2}$",
        },
        limit: {
          type: "integer",
          description: "Maximum number of servers to show.",
          minimum: 1,
          maximum: 1000,
        },
        protocol: {
          type: "string",
          enum: ["openvpn_udp", "openvpn_tcp"],
          description: "OpenVPN transport protocol.",
        },
      },
      required: ["country"],
      additionalProperties: false,
    },
  },
  {
    name: "vpn_connect",
    description: "Connect NordVPN by country or exact server hostname.",
    inputSchema: {
      type: "object",
      properties: {
        country: {
          type: "string",
          description: "Optional two-letter country code. Defaults to US if neither country nor server is provided.",
          pattern: "^[A-Za-z]{2}$",
        },
        server: {
          type: "string",
          description: "Optional exact NordVPN hostname, such as us1234.nordvpn.com.",
          minLength: 1,
        },
        protocol: {
          type: "string",
          enum: ["openvpn_udp", "openvpn_tcp"],
          description: "OpenVPN transport protocol.",
        },
        killswitch: {
          type: "boolean",
          description: "Enable the pf-based kill switch for this connection.",
        },
        verifyAfterConnect: {
          type: "boolean",
          description: "Wait briefly after connect and run a follow-up status check.",
        },
        settleSeconds: {
          type: "integer",
          description: "How many seconds to wait before the follow-up status check.",
          minimum: 0,
          maximum: 30,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "vpn_disconnect",
    description: "Disconnect the current NordVPN session.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "vpn_rotate",
    description: "Rotate to another NordVPN server in the last selected country.",
    inputSchema: {
      type: "object",
      properties: {
        maxLoad: {
          type: "number",
          description: "Only consider servers at or below this load percentage.",
          minimum: 0,
          maximum: 100,
        },
        killswitch: {
          type: "boolean",
          description: "Preserve the pf-based kill switch while rotating.",
        },
        verifyAfterRotate: {
          type: "boolean",
          description: "Wait briefly after rotate and run a follow-up status check.",
        },
        settleSeconds: {
          type: "integer",
          description: "How many seconds to wait before the follow-up status check.",
          minimum: 0,
          maximum: 30,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "vpn_setup",
    description: "Run the one-time NordVPN CLI setup for passwordless sudo rules.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

function ensureEnvironment(): void {
  const currentPath = process.env.PATH ?? "";
  const segments = currentPath.split(":").filter((segment) => segment.trim() !== "");

  if (!segments.includes(HOMEBREW_BIN)) {
    segments.unshift(HOMEBREW_BIN);
  }
  if (!segments.includes(HOMEBREW_SBIN)) {
    segments.unshift(HOMEBREW_SBIN);
  }

  process.env.PATH = segments.join(":");
}

function normalizeProjectRoot(value: string | undefined): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    throw new Error(
      "NordVPN project root is required. Pass it as the first argument or set NORDVPN_PROJECT_ROOT.",
    );
  }
  return normalized;
}

function ensureProjectPaths(): void {
  if (!existsSync(configuredProjectRoot)) {
    throw new Error(`NordVPN project root not found: ${configuredProjectRoot}`);
  }
  if (!existsSync(configuredPythonBin)) {
    throw new Error(`NordVPN Python binary not found: ${configuredPythonBin}`);
  }
  if (!existsSync(join(configuredProjectRoot, "pyproject.toml"))) {
    throw new Error(`pyproject.toml not found in ${configuredProjectRoot}`);
  }
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function validateCountryCode(value: unknown, fieldName: string): string | undefined {
  const normalized = normalizeString(value);
  if (!normalized) return undefined;
  if (!COUNTRY_CODE_PATTERN.test(normalized)) {
    throw new Error(`${fieldName} must be a two-letter country code`);
  }
  return normalized.toUpperCase();
}

function validateServer(value: unknown): string | undefined {
  const normalized = normalizeString(value);
  if (!normalized) return undefined;
  if (!SERVER_PATTERN.test(normalized)) {
    throw new Error("server must be a valid NordVPN hostname like us1234.nordvpn.com");
  }
  return normalized.includes(".") ? normalized : `${normalized}.nordvpn.com`;
}

function validateProtocol(value: unknown): string | undefined {
  const normalized = normalizeString(value);
  if (!normalized) return undefined;
  if (normalized !== "openvpn_udp" && normalized !== "openvpn_tcp") {
    throw new Error("protocol must be 'openvpn_udp' or 'openvpn_tcp'");
  }
  return normalized;
}

function validatePositiveInteger(value: unknown, fieldName: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${fieldName} must be a positive integer`);
  }
  return value;
}

function validateIntegerRange(
  value: unknown,
  fieldName: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${fieldName} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function validateLoadPercentage(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error("maxLoad must be a number between 0 and 100");
  }
  return value;
}

function validateBoolean(value: unknown, fieldName: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new Error(`${fieldName} must be a boolean`);
  }
  return value;
}

function isStateChangingTool(toolName: string): boolean {
  return STATEFUL_TOOLS.has(toolName);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timeoutForTool(toolName: string): number {
  return COMMAND_TIMEOUTS_MS[toolName] ?? 60_000;
}

async function withStatefulToolLock<T>(toolName: string, action: () => Promise<T>): Promise<T> {
  if (!isStateChangingTool(toolName)) {
    return await action();
  }

  const previous = statefulToolQueue;
  let release: (() => void) | undefined;
  statefulToolQueue = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous.catch(() => undefined);

  try {
    return await action();
  } finally {
    release?.();
  }
}

async function ensureOpenVpnAvailable(): Promise<void> {
  ensureEnvironment();

  await new Promise<void>((resolve, reject) => {
    const child = spawn("openvpn", ["--version"], {
      cwd: configuredProjectRoot,
      env: process.env,
      stdio: ["ignore", "ignore", "ignore"],
    });

    child.on("error", () => {
      reject(new Error("openvpn is not available on PATH"));
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error("openvpn is installed incorrectly or not executable"));
    });
  });
}

async function validateEnvironmentForTool(toolName: string): Promise<void> {
  ensureProjectPaths();

  if ((toolName === "vpn_connect" || toolName === "vpn_rotate") && !existsSync(AUTH_FILE)) {
    throw new Error(`NordVPN auth file not found: ${AUTH_FILE}`);
  }

  if (toolName === "vpn_connect" || toolName === "vpn_rotate" || toolName === "vpn_setup") {
    await ensureOpenVpnAvailable();
  }
}

function buildCommand(toolName: string, args: ToolArgs | undefined): string[] {
  switch (toolName) {
    case "vpn_status":
      return ["-m", "nordvpn", "status"];
    case "vpn_list_countries":
      return ["-m", "nordvpn", "list-countries"];
    case "vpn_list_servers": {
      const country = validateCountryCode(args?.country, "country");
      const limit = validatePositiveInteger(args?.limit, "limit");
      const protocol = validateProtocol(args?.protocol);

      if (!country) {
        throw new Error("country is required");
      }

      const command = ["-m", "nordvpn", "list", country];
      if (limit !== undefined) command.push("--limit", String(limit));
      if (protocol) command.push("--proto", protocol);
      return command;
    }
    case "vpn_connect": {
      const country = validateCountryCode(args?.country, "country");
      const server = validateServer(args?.server);
      const protocol = validateProtocol(args?.protocol);
      const killswitch = validateBoolean(args?.killswitch, "killswitch");

      if (country && server) {
        throw new Error("Provide either country or server, not both");
      }

      const command = ["-m", "nordvpn", "connect"];
      if (country) command.push(country);
      if (server) command.push("--server", server);
      if (protocol) command.push("--proto", protocol);
      if (killswitch === true) command.push("--killswitch");
      return command;
    }
    case "vpn_disconnect":
      return ["-m", "nordvpn", "disconnect"];
    case "vpn_rotate": {
      const maxLoad = validateLoadPercentage(args?.maxLoad);
      const killswitch = validateBoolean(args?.killswitch, "killswitch");
      const command = ["-m", "nordvpn", "rotate"];
      if (maxLoad !== undefined) command.push("--max-load", String(maxLoad));
      if (killswitch === true) command.push("--killswitch");
      return command;
    }
    case "vpn_setup":
      return ["-m", "nordvpn", "setup"];
    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

async function runCli(toolName: string, command: string[]): Promise<CliResult> {
  ensureEnvironment();
  await validateEnvironmentForTool(toolName);

  return await new Promise((resolve, reject) => {
    const child = spawn(configuredPythonBin, command, {
      cwd: configuredProjectRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
      }, 2_000).unref();
    }, timeoutForTool(toolName));

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({
        toolName,
        command: [configuredPythonBin, ...command],
        exitCode: code ?? 1,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        timedOut,
      });
    });
  });
}

function parseCountriesOutput(stdout: string): Record<string, unknown> | undefined {
  if (!stdout) return undefined;

  const countries = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => COUNTRY_CODE_PATTERN.test(line.slice(0, 2)))
    .map((line) => {
      const match = line.match(/^([A-Za-z]{2})\s+(.+)$/);
      if (!match) return undefined;
      return {
        code: match[1].toUpperCase(),
        name: match[2].trim(),
      };
    })
    .filter((country): country is { code: string; name: string } => Boolean(country));

  return { countries };
}

function parseServersOutput(stdout: string): Record<string, unknown> | undefined {
  if (!stdout) return undefined;

  const lines = stdout.split("\n");
  const header = lines.find((line) => line.startsWith("Servers in "))?.trim();
  const servers: Array<{ hostname: string; load?: number; city?: string }> = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line.includes(" load ") || !line.includes(".nordvpn.com")) {
      continue;
    }

    const match = line.match(/^([^\s]+)\s+load\s+([0-9?]+)%(?:\s+—\s+(.+))?$/);
    if (!match) {
      continue;
    }

    servers.push({
      hostname: match[1],
      load: match[2] === "?" ? undefined : Number(match[2]),
      city: match[3]?.trim() || undefined,
    });
  }

  return { header, servers };
}

function parseToolOutput(toolName: string, stdout: string): Record<string, unknown> | undefined {
  switch (toolName) {
    case "vpn_status":
      return parseStatusOutput(stdout);
    case "vpn_list_countries":
      return parseCountriesOutput(stdout);
    case "vpn_list_servers":
      return parseServersOutput(stdout);
    default:
      return undefined;
  }
}

function buildStructuredResult(result: CliResult): StructuredResult {
  const structured: StructuredResult = {
    tool: result.toolName,
    success: result.exitCode === 0,
    exitCode: result.exitCode,
    command: result.command,
    stdout: result.stdout,
    stderr: result.stderr,
    stateChanged: isStateChangingTool(result.toolName),
    timedOut: result.timedOut,
  };

  structured.parsed = parseToolOutput(result.toolName, result.stdout);

  if (result.timedOut) {
    structured.error = `Command timed out after ${timeoutForTool(result.toolName)}ms`;
  }

  return structured;
}

function normalizeToolArgs(toolName: string, args: ToolArgs | undefined): ToolArgs {
  switch (toolName) {
    case "vpn_connect": {
      const country = validateCountryCode(args?.country, "country");
      const server = validateServer(args?.server);
      const protocol = validateProtocol(args?.protocol);
      const killswitch = validateBoolean(args?.killswitch, "killswitch");
      const verifyAfterConnect = validateBoolean(args?.verifyAfterConnect, "verifyAfterConnect") ?? false;
      const settleSeconds = validateIntegerRange(args?.settleSeconds, "settleSeconds", 0, 30) ?? 12;

      if (country && server) {
        throw new Error("Provide either country or server, not both");
      }

      return {
        country,
        server,
        protocol,
        killswitch,
        verifyAfterConnect,
        settleSeconds,
      };
    }
    case "vpn_list_servers":
      return {
        country: validateCountryCode(args?.country, "country"),
        limit: validatePositiveInteger(args?.limit, "limit"),
        protocol: validateProtocol(args?.protocol),
      };
    case "vpn_rotate":
      return {
        maxLoad: validateLoadPercentage(args?.maxLoad),
        killswitch: validateBoolean(args?.killswitch, "killswitch"),
        verifyAfterRotate: validateBoolean(args?.verifyAfterRotate, "verifyAfterRotate") ?? false,
        settleSeconds: validateIntegerRange(args?.settleSeconds, "settleSeconds", 0, 30) ?? 12,
      };
    default:
      return args ?? {};
  }
}

function formatResult(result: CliResult): string {
  const parts = [
    `Command: ${result.command.join(" ")}`,
    `Exit code: ${result.exitCode}`,
  ];

  if (result.timedOut) {
    parts.push(`Timed out: yes (${timeoutForTool(result.toolName)}ms)`);
  }

  if (result.stdout) {
    parts.push("", "STDOUT:", result.stdout);
  }
  if (result.stderr) {
    parts.push("", "STDERR:", result.stderr);
  }

  return parts.join("\n");
}

function formatCombinedResult(result: CliResult, verification?: StructuredResult & { settledSeconds: number }): string {
  const parts = [formatResult(result)];

  if (verification) {
    parts.push(
      "",
      `Verification after ${verification.settledSeconds}s:`,
      `Success: ${verification.success ? "yes" : "no"}`,
    );

    if (verification.verification?.reason) {
      parts.push(`Reason: ${verification.verification.reason}`);
    }

    if (verification.stdout) {
      parts.push("", "Verification STDOUT:", verification.stdout);
    }
    if (verification.stderr) {
      parts.push("", "Verification STDERR:", verification.stderr);
    }
  }

  return parts.join("\n");
}

async function verifyVpnState(options: {
  toolName: "vpn_connect" | "vpn_rotate";
  settledSeconds: number;
  expectedCountry?: string;
}): Promise<StructuredResult & { settledSeconds: number; verification: NonNullable<StructuredResult["verification"]> }> {
  await sleep(options.settledSeconds * 1000);

  const verificationCliResult = await runCli("vpn_status", ["-m", "nordvpn", "status"]);
  const verificationStructured = buildStructuredResult(verificationCliResult);
  const parsed = verificationStructured.parsed;
  const connected = parsed?.connected;
  const observedCountry = statusCountryCode(parsed);
  const verificationState =
    parsed && typeof parsed.verificationState === "string" ? parsed.verificationState : undefined;
  const verificationMessage =
    parsed && typeof parsed.verificationMessage === "string" ? parsed.verificationMessage : undefined;

  let success = verificationStructured.success;
  let reason: string | undefined;

  if (verificationStructured.timedOut) {
    success = false;
    reason = `verification status timed out after ${timeoutForTool("vpn_status")}ms`;
  } else if (connected !== true) {
    success = false;
    reason = "verification status did not report an active VPN connection";
  } else if (verificationState === "country_mismatch") {
    success = false;
    reason = verificationMessage ?? "verification reported a country mismatch";
  } else if (verificationState === "country_unconfirmed") {
    success = false;
    reason = verificationMessage ?? "verification could not confirm country consensus";
  } else if (verificationState === "verified") {
    success = true;
    reason = undefined;
  } else if (options.expectedCountry && observedCountry && observedCountry !== options.expectedCountry) {
    success = false;
    reason = `verification country mismatch: expected ${options.expectedCountry}, observed ${observedCountry}`;
  } else if (options.expectedCountry && !observedCountry) {
    success = false;
    reason = "verification could not determine the observed country";
  }

  return {
    ...verificationStructured,
    success,
    settledSeconds: options.settledSeconds,
    verification: {
      settledSeconds: options.settledSeconds,
      success,
      reason,
      expectedCountry: options.expectedCountry,
      observedCountry,
      result: verificationStructured,
    },
  };
}

const server = new Server(
  { name: "nordvpn-mcp", version: "0.2.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    const normalizedArgs = normalizeToolArgs(name, (args ?? {}) as ToolArgs);
    const command = buildCommand(name, normalizedArgs);
    const result = await withStatefulToolLock(name, async () => await runCli(name, command));
    const structuredResult = buildStructuredResult(result);

    if (name === "vpn_connect" && result.exitCode === 0 && normalizedArgs.verifyAfterConnect === true) {
      const settledSeconds = normalizedArgs.settleSeconds as number;
      const expectedCountry = (normalizedArgs.country as string | undefined) ?? undefined;
      const verificationStructured = await verifyVpnState({
        toolName: "vpn_connect",
        settledSeconds,
        expectedCountry,
      });

      return {
        content: [{ type: "text", text: formatCombinedResult(result, verificationStructured) }],
        structuredContent: {
          ...structuredResult,
          verification: verificationStructured.verification,
        },
        isError: result.exitCode !== 0 || result.timedOut === true || verificationStructured.success !== true,
      };
    }

    if (name === "vpn_rotate" && result.exitCode === 0 && normalizedArgs.verifyAfterRotate === true) {
      const settledSeconds = normalizedArgs.settleSeconds as number;
      const preRotateStatus = await runCli("vpn_status", ["-m", "nordvpn", "status"]);
      const preRotateParsed = buildStructuredResult(preRotateStatus).parsed;
      const expectedCountry = statusCountryCode(preRotateParsed);
      const verificationStructured = await verifyVpnState({
        toolName: "vpn_rotate",
        settledSeconds,
        expectedCountry,
      });

      return {
        content: [{ type: "text", text: formatCombinedResult(result, verificationStructured) }],
        structuredContent: {
          ...structuredResult,
          verification: verificationStructured.verification,
        },
        isError: result.exitCode !== 0 || result.timedOut === true || verificationStructured.success !== true,
      };
    }

    return {
      content: [{ type: "text", text: formatResult(result) }],
      structuredContent: structuredResult,
      isError: result.exitCode !== 0 || result.timedOut === true,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: message }],
      structuredContent: {
        tool: name,
        success: false,
        error: message,
      },
      isError: true,
    };
  }
});

async function main(): Promise<void> {
  ensureEnvironment();
  ensureProjectPaths();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
