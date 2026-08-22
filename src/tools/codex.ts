import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * Wraps the official `codex mcp-server` binary, spawned once as a long-lived
 * child MCP client. The server keeps Codex sessions alive across turns, so
 * thread ids remain valid for `reply()` (approval veto loop, follow-ups).
 *
 * Codex surfaces shell-command approvals as MCP `elicitation/create` requests
 * to the client. We declare the elicitation capability and intercept those
 * requests so approvals are answered (per an ApprovalPolicy) instead of dying
 * with "Method not found" — which would abort the session.
 *
 * Note: codex parses the approval response as a FLAT `ExecApprovalResponse
 * { decision }`, not the MCP `ElicitResult { action, content }` shape
 * (openai/codex#18268, still present in 0.147.0). We therefore respond on the
 * raw transport with `{ decision: "approved" | "denied" }`, bypassing the
 * SDK's ElicitResult validation. Every approval is recorded in the result so
 * ChatGPT can relay it to the user for a veto.
 */

type CodexSandbox = "read-only" | "workspace-write";
type CodexApprovalPolicy = "untrusted" | "on-request" | "never";

export type ApprovalDecision =
  | { action: "accept"; content?: Record<string, unknown> }
  | { action: "decline"; content?: Record<string, unknown> }
  | { action: "cancel" };

export interface ElicitationInfo {
  mode: "form" | "url";
  message: string;
  requestedSchema?: unknown;
  url?: string;
}

type ApprovalPolicy = (elicit: ElicitationInfo) => ApprovalDecision;

interface CodexRunOptions {
  /** Initial user prompt for the session. */
  prompt: string;
  /** Sandbox mode. Never `danger-full-access`. */
  sandbox: CodexSandbox;
  /** Working directory for the session (a configured project root). */
  cwd: string;
  /** Approval policy for shell commands (default `untrusted`). */
  approvalPolicy?: CodexApprovalPolicy;
  /**
   * Model override for this session. Defaults to the fixed cheap model
   * (gpt-5.6-luna). Only deep_explore may pass one — and only after the user
   * explicitly confirmed the model change in chat.
   */
  model?: string;
  /** Extra instructions injected as a developer-role message. */
  developerInstructions?: string;
  /** Decides how elicitation (approval) requests are answered. */
  onApproval?: ApprovalPolicy;
}

interface CodexResult {
  threadId: string | undefined;
  text: string;
  isError: boolean;
  /** Every approval request seen during the call, formatted for relaying. */
  approvals: string[];
  raw: unknown;
}

const BRIDGE_VERSION = "0.1.0";
const DEFAULT_TIMEOUT_MS = 600_000; // long enough for multi-minute implementation runs
/** Upper bound on remembered thread→project bindings (oldest dropped first). */
const MAX_THREADS = 100;

/**
 * Fixed Codex settings for every call made THROUGH THIS BRIDGE. Passed as
 * per-call overrides on the codex tool, so the user's own Codex config
 * (~/.codex/config.toml) is never involved and never modified.
 *
 * - Model: gpt-5.6-luna (cheapest/fastest of the 5.6 family → smallest usage burn)
 * - Reasoning: medium (no xhigh burn)
 * - Fast Mode: off (fast tier spends extra tokens for speed)
 */
export const FIXED_CODEX_MODEL = "gpt-5.6-luna";

interface CodexToolDefinition {
  name: string;
  inputSchema: { properties?: Record<string, unknown> };
}

export function assertCodexToolCompatibility(tools: Iterable<CodexToolDefinition>): void {
  const byName = new Map(Array.from(tools, (tool) => [tool.name, tool]));
  const requiredInputs: Record<string, string[]> = {
    codex: ["prompt", "sandbox", "cwd", "approval-policy", "model", "config", "developer-instructions"],
    "codex-reply": ["threadId", "prompt"],
  };
  for (const [name, required] of Object.entries(requiredInputs)) {
    const tool = byName.get(name);
    if (!tool) throw new Error(`incompatible Codex MCP server: missing tool ${name}`);
    const properties = tool.inputSchema.properties ?? {};
    const missing = required.filter((property) => !(property in properties));
    if (missing.length > 0) {
      throw new Error(`incompatible Codex MCP server: ${name} is missing input(s) ${missing.join(", ")}`);
    }
  }
}

/**
 * Gate a non-default Codex model behind explicit user confirmation.
 * Throws with guidance when a model override is supplied without
 * `confirmed: true` — so a model can never switch to an expensive
 * model on its own judgment. Per-call: each non-default model use
 * must be confirmed by the user.
 */
export function guardModelOverride(
  model: string | undefined,
  confirmed: boolean | undefined,
): void {
  if (model && model !== FIXED_CODEX_MODEL && confirmed !== true) {
    throw new Error(
      `Refused model "${model}": it needs the user's explicit confirmation. ` +
        `Ask the user: "May I use ${model} for this? It costs more than the default ${FIXED_CODEX_MODEL}." ` +
        `Retry with model_confirmed: true only after they say yes.`,
    );
  }
}
const FIXED_CODEX_CONFIG = {
  model_reasoning_effort: "medium",
  features: { fast_mode: false },
} as const;

export class CodexServer {
  private readonly client: Client;
  private readonly transport: StdioClientTransport;
  /** threadId -> project root that created the session (for codex_reply gating). */
  private readonly threadRoots = new Map<string, string>();
  /** Promise chain: serializes all calls so the single codex child never has two in-flight sessions. */
  private queue: Promise<unknown> = Promise.resolve();
  /** Policy+log for the single in-flight call (safe: the queue serializes calls). */
  private currentCall: { log: string[]; policy: ApprovalPolicy | undefined } | undefined;

  private constructor(client: Client, transport: StdioClientTransport) {
    this.client = client;
    this.transport = transport;
  }

  /** Spawn `codex mcp-server` (once) and connect to it. */
  static async start(onClose?: () => void): Promise<CodexServer> {
    const transport = new StdioClientTransport({
      command: "codex",
      args: ["mcp-server"],
      env: { ...process.env } as Record<string, string>,
      cwd: process.cwd(),
      stderr: "inherit",
    });

    const client = new Client(
      { name: "cheap-labor", version: BRIDGE_VERSION },
      {
        capabilities: {
          // Codex sends shell-command approvals as elicitation requests.
          elicitation: { form: { applyDefaults: true } },
        },
      },
    );

    const server = new CodexServer(client, transport);

    try {
      await client.connect(transport);
      const listed = await client.listTools();
      assertCodexToolCompatibility(listed.tools);
    } catch (e) {
      await transport.close().catch(() => {});
      throw new Error(
        `Failed to start the official codex mcp-server. Is the Codex CLI installed and logged in? ` +
          `(${(e as Error).message})`,
      );
    }
    server.installElicitationInterceptor();
    if (onClose) {
      const protocolOnClose = transport.onclose;
      transport.onclose = () => {
        protocolOnClose?.();
        onClose();
      };
    }
    return server;
  }

  /** Run `fn` after all previously enqueued calls finish (never skips on prior failure). */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Start a fresh Codex session. */
  async run(opts: CodexRunOptions): Promise<CodexResult> {
    return this.enqueue(() => this.doRun(opts));
  }

  private async doRun(opts: CodexRunOptions): Promise<CodexResult> {
    const args: Record<string, unknown> = {
      prompt: opts.prompt,
      sandbox: opts.sandbox,
      cwd: opts.cwd,
      "approval-policy": opts.approvalPolicy ?? "untrusted",
      model: opts.model ?? FIXED_CODEX_MODEL,
      config: { ...FIXED_CODEX_CONFIG },
    };
    if (opts.developerInstructions) args["developer-instructions"] = opts.developerInstructions;

    const call = { log: [], policy: opts.onApproval };
    this.currentCall = call;
    try {
      const res = await this.client.callTool({ name: "codex", arguments: args }, undefined, {
        timeout: DEFAULT_TIMEOUT_MS,
        maxTotalTimeout: DEFAULT_TIMEOUT_MS,
      });
      const result = parseResult(res, call.log);
      // Bind the new thread to the project that created it, so codex_reply
      // (which has no other context) can be gated to the same project+chat.
      if (result.threadId) {
        this.threadRoots.set(result.threadId, opts.cwd);
        this.pruneThreads();
      }
      return result;
    } finally {
      this.currentCall = undefined;
    }
  }

  /** Continue an existing session by thread id (approval veto, follow-ups). */
  async reply(
    threadId: string,
    prompt: string,
    onApproval?: ApprovalPolicy,
  ): Promise<CodexResult> {
    return this.enqueue(() => this.doReply(threadId, prompt, onApproval));
  }

  private async doReply(
    threadId: string,
    prompt: string,
    onApproval?: ApprovalPolicy,
  ): Promise<CodexResult> {
    if (!this.threadRoots.has(threadId)) {
      throw new Error(
        `Unknown or expired Codex thread "${threadId}". Threads belong to the chat that created them ` +
          `and are not valid across chats or bridge restarts.`,
      );
    }
    const call = { log: [], policy: onApproval };
    this.currentCall = call;
    try {
      const res = await this.client.callTool(
        { name: "codex-reply", arguments: { threadId, prompt } },
        undefined,
        { timeout: DEFAULT_TIMEOUT_MS, maxTotalTimeout: DEFAULT_TIMEOUT_MS },
      );
      return parseResult(res, call.log);
    } finally {
      this.currentCall = undefined;
    }
  }

  /** The project root a thread was created in, or undefined. */
  rootForThread(threadId: string): string | undefined {
    return this.threadRoots.get(threadId);
  }

  /** Keep the thread map bounded (oldest dropped first — Maps iterate in insertion order). */
  private pruneThreads(): void {
    while (this.threadRoots.size > MAX_THREADS) {
      const oldest = this.threadRoots.keys().next().value;
      if (oldest === undefined) break;
      this.threadRoots.delete(oldest);
    }
  }

  async close(): Promise<void> {
    await this.client.close().catch(() => {});
    await this.transport.close().catch(() => {});
  }

  /**
   * Intercept codex's `elicitation/create` requests at the transport level and
   * answer them with the flat `{ decision }` shape codex actually parses.
   */
  private installElicitationInterceptor(): void {
    const transport = this.transport;
    const protoOnMessage = transport.onmessage;
    transport.onmessage = (message) => {
      const m = message as { method?: string; id?: unknown; params?: Record<string, unknown> };
      if (m?.method === "elicitation/create" && m.id !== undefined) {
        void this.answerElicitation({ id: m.id, params: m.params }).catch((e) => {
          process.stderr.write(`[bridge] failed to answer codex approval: ${(e as Error).message}\n`);
        });
        return; // swallowed: the Protocol never sees it, so it won't reply
      }
      return protoOnMessage ? protoOnMessage(message) : undefined;
    };
  }

  private async answerElicitation(m: {
    id: unknown;
    params?: Record<string, unknown>;
  }): Promise<void> {
    const params = (m.params ?? {}) as {
      mode?: "form" | "url";
      message?: string;
      requestedSchema?: unknown;
      url?: string;
    };
    const info: ElicitationInfo = {
      mode: params.mode ?? "form",
      message: params.message ?? "",
      requestedSchema: params.requestedSchema,
      url: params.url,
    };
    // Only the active call answers elicitations; anything arriving outside a
    // call is declined so a stray request can't hang a session.
    const call = this.currentCall;
    const decision = call?.policy
      ? call.policy(info)
      : { action: "decline" as const, content: { decision: "denied" } };
    call?.log.push(formatApproval(info, decision));
    if (process.env.CODEX_DEBUG) {
      process.stderr.write(`[codex approval] ${JSON.stringify({ info, decision }).slice(0, 500)}\n`);
    }
    const flat = decision.action === "accept" ? { decision: "approved" } : { decision: "denied" };
    await this.transport.send({
      jsonrpc: "2.0",
      id: m.id,
      result: flat,
    } as never);
  }
}

/** Lazily-initialized singleton: one `codex mcp-server` process per bridge. */
let instancePromise: Promise<CodexServer> | undefined;
let closingPromise: Promise<void> | undefined;
export type CodexServerFactory = (onClose?: () => void) => Promise<CodexServer>;

/** True once the codex child has been spawned. Threads only exist in-process. */
export function hasCodexServer(): boolean {
  return instancePromise !== undefined;
}

export async function getCodexServer(start: CodexServerFactory = CodexServer.start): Promise<CodexServer> {
  if (closingPromise) await closingPromise;
  if (!instancePromise) {
    let pending: Promise<CodexServer>;
    pending = start(() => {
      if (instancePromise === pending) instancePromise = undefined;
    });
    instancePromise = pending;
    void pending.catch(() => {
      if (instancePromise === pending) instancePromise = undefined;
    });
  }
  return instancePromise;
}

export async function closeCodexServer(): Promise<void> {
  if (closingPromise) return closingPromise;
  const pending = instancePromise;
  if (!pending) return;
  instancePromise = undefined;
  closingPromise = (async () => {
    try {
      const server = await pending;
      await server.close();
    } catch {
      // Startup already closed its transport before rejecting.
    } finally {
      closingPromise = undefined;
    }
  })();
  return closingPromise;
}

function parseResult(res: unknown, approvals: string[]): CodexResult {
  const r = res as {
    content?: Array<{ type: string; text?: string }>;
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  };
  const text =
    r.content?.filter((c) => c.type === "text" && c.text).map((c) => c.text as string).join("\n") ??
    "";
  const structured = (r.structuredContent ?? {}) as { threadId?: string };
  return {
    threadId: structured.threadId ?? extractThreadId(text),
    text,
    isError: r.isError ?? false,
    approvals,
    raw: r,
  };
}

function extractThreadId(text: string): string | undefined {
  const m = text.match(/"threadId"\s*:\s*"([^"]+)"/);
  return m?.[1];
}

function formatApproval(info: ElicitationInfo, decision: ApprovalDecision): string {
  const verb = decision.action === "accept" ? "APPROVED" : decision.action === "decline" ? "DENIED" : "CANCELLED";
  return `[approval ${verb}] ${info.message}${info.url ? ` (url: ${info.url})` : ""}`;
}
