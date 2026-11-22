// Running the agent loop in a Web Worker. The worker owns the loop (context assembly, compaction, redaction, limits,
// verification feedback); the main thread owns everything that needs Tauri IPC or the DOM (files, HTTP, permission
// prompts, indexing) and serves it to the worker over a typed message protocol. Heavy work never blocks the UI.

import type { AgentEvent, Message, Mode, ModelGateway, ModelRequest, PermissionGate, StreamEvent, ToolCall, ToolHost, ToolResult, ToolSpec } from "@forge/protocol";
import type { HookRunner, VerificationReport } from "@forge/verify";
import type { ContextSection, MeterEntry } from "./context";
import { Runtime, type RuntimeDeps } from "./index";

/** The subset of MessagePort both ends use (browser and Node's MessageChannel both satisfy it). */
export interface Port {
  postMessage(message: unknown): void;
  onmessage: ((e: { data: unknown }) => void) | null;
  start?(): void;
  close?(): void;
}

/** What the UI needs from an agent loop, whether it runs in-process (`Runtime`) or in a worker (`RuntimeClient`). */
export interface AgentRuntime {
  readonly history: Message[];
  readonly costUsd: number;
  readonly summaries: string[];
  readonly running: boolean;
  meter(): RuntimeSnapshot["meter"];
  run(req: { mode: Mode; prompt: string; signal?: AbortSignal }): AsyncIterable<AgentEvent>;
  sessionStart(): Promise<AgentEvent | null>;
  setHistory(history: Message[]): void;
  addCost(usd: number): void;
  setModel(provider: string, model: string): void;
  /** Where the loop runs: "process", "worker" or "inline". */
  transport?: string;
  /** Release the worker or process. */
  terminate?(): void;
}

const MODES: Mode[] = ["ask", "plan", "agent", "debug"];

export interface RuntimeConfig {
  provider: string;
  model: string;
  budgetTokens?: number;
  limits?: RuntimeDeps["limits"];
  compaction?: { enabled?: boolean; threshold?: number; keepRecent?: number };
  basePrompt?: string;
}

/** Static, serialisable facts the worker needs up front (it cannot call sync functions on the main thread). */
interface InitMessage {
  t: "init";
  config: RuntimeConfig;
  toolSpecs: Record<Mode, ToolSpec[]>;
  modePrompts: Record<Mode, string | undefined>;
  verify: { enabled: boolean; maxAttempts?: number; root: string } | null;
  hasHooks: boolean;
  hasGate: boolean;
  hasSections: boolean;
}

export interface RuntimeSnapshot {
  history: Message[];
  costUsd: number;
  summaries: string[];
  meter: { total: number; entries: MeterEntry[]; ratio: number; calibrated: boolean; lastReported: number };
  running: boolean;
}

type ToWorker =
  | InitMessage
  | { t: "run"; rid: number; req: { mode: Mode; prompt: string } }
  | { t: "abort"; rid: number }
  | { t: "set-history"; history: Message[] }
  | { t: "add-cost"; usd: number }
  | { t: "session-start"; cid: number }
  | { t: "set-model"; provider: string; model: string }
  | { t: "reply"; cid: number; ok: boolean; value?: unknown; error?: string }
  | { t: "stream-event"; sid: number; ev: StreamEvent }
  | { t: "stream-end"; sid: number }
  | { t: "stream-error"; sid: number; error: string; retryable?: boolean; name?: string };

type ToHost =
  | { t: "ready" }
  | { t: "event"; rid: number; ev: AgentEvent }
  | { t: "end"; rid: number; snapshot: RuntimeSnapshot }
  | { t: "error"; rid: number; error: string; name?: string; retryable?: boolean }
  | { t: "call"; cid: number; method: HostMethod; args: unknown[] }
  | { t: "stream"; sid: number; req: Omit<ModelRequest, "signal"> }
  | { t: "stream-abort"; sid: number }
  | { t: "audit"; entry: { kind: "model" | "tool"; name: string; detail?: string } }
  | { t: "reply"; cid: number; ok: boolean; value?: unknown; error?: string };

type HostMethod = "tools.call" | "gate.check" | "sections" | "verify.run" | "hooks.run";

// ============================== worker side ==============================

/** Run inside the worker: `serveRuntime(self)`. */
export function serveRuntime(port: Port) {
  let runtime: Runtime | null = null;
  let nextCid = 1;
  let nextSid = 1;
  const calls = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const streams = new Map<number, { push: (ev: StreamEvent) => void; end: () => void; fail: (e: Error) => void }>();
  const runs = new Map<number, AbortController>();
  const send = (m: ToHost) => port.postMessage(m);

  const call = <T>(method: HostMethod, ...args: unknown[]) =>
    new Promise<T>((resolve, reject) => {
      const cid = nextCid++;
      calls.set(cid, { resolve: resolve as (v: unknown) => void, reject });
      send({ t: "call", cid, method, args });
    });

  const gateway: ModelGateway = {
    stream(req) {
      const sid = nextSid++;
      const queue: (StreamEvent | { end: true } | { error: Error })[] = [];
      let wake: (() => void) | null = null;
      const put = (x: (typeof queue)[number]) => {
        queue.push(x);
        wake?.();
      };
      streams.set(sid, { push: (ev) => put(ev), end: () => put({ end: true }), fail: (e) => put({ error: e }) });
      const { signal, ...serialisable } = req;
      send({ t: "stream", sid, req: serialisable });
      signal?.addEventListener("abort", () => send({ t: "stream-abort", sid }), { once: true });
      return {
        async *[Symbol.asyncIterator]() {
          try {
            for (;;) {
              while (queue.length === 0) await new Promise<void>((r) => (wake = r));
              wake = null;
              const x = queue.shift()!;
              if ("error" in x) throw x.error;
              if ("end" in x) return;
              yield x;
            }
          } finally {
            streams.delete(sid);
          }
        },
      };
    },
  };

  const snapshot = (rt: Runtime): RuntimeSnapshot => ({ history: rt.history, costUsd: rt.costUsd, summaries: rt.summaries, meter: rt.meter(), running: rt.running });

  const build = (m: InitMessage) => {
    const tools: ToolHost = {
      listTools: (mode) => m.toolSpecs[mode] ?? [],
      call: (mode, c: ToolCall) => call<ToolResult>("tools.call", mode, c),
    };
    const gate: PermissionGate | undefined = m.hasGate ? { check: (cls, c) => call("gate.check", cls, c) } : undefined;
    const hooks = m.hasHooks ? ({ run: (event: string, ctx?: unknown) => call("hooks.run", event, ctx) } as unknown as HookRunner) : undefined;
    runtime = new Runtime({
      gateway,
      tools,
      gate,
      hooks,
      provider: m.config.provider,
      model: m.config.model,
      budgetTokens: m.config.budgetTokens,
      limits: m.config.limits,
      compaction: m.config.compaction,
      basePrompt: m.config.basePrompt,
      modePrompt: (mode) => m.modePrompts[mode],
      sections: m.hasSections ? () => call<ContextSection[]>("sections") : undefined,
      verify: m.verify
        ? {
            enabled: () => m.verify!.enabled,
            maxAttempts: m.verify.maxAttempts,
            root: m.verify.root,
            run: (touched, phase, attempt) => call<VerificationReport>("verify.run", touched, phase, attempt),
          }
        : undefined,
      audit: (entry) => send({ t: "audit", entry }),
    });
    send({ t: "ready" });
  };

  port.onmessage = (e) => {
    const m = e.data as ToWorker;
    switch (m.t) {
      case "init":
        return build(m);
      case "run": {
        const rt = runtime;
        if (!rt) return send({ t: "error", rid: m.rid, error: "runtime not initialised" });
        const ac = new AbortController();
        runs.set(m.rid, ac);
        void (async () => {
          try {
            for await (const ev of rt.run({ ...m.req, signal: ac.signal })) send({ t: "event", rid: m.rid, ev });
            send({ t: "end", rid: m.rid, snapshot: snapshot(rt) });
          } catch (err) {
            const x = err as { message?: string; name?: string; retryable?: boolean };
            send({ t: "error", rid: m.rid, error: x?.message ?? String(err), name: x?.name, retryable: x?.retryable });
          } finally {
            runs.delete(m.rid);
          }
        })();
        return;
      }
      case "abort":
        return runs.get(m.rid)?.abort();
      case "set-history":
        return runtime?.setHistory(m.history);
      case "add-cost":
        // Its own message: it can arrive mid-run (a sub-agent finishing), so it must never carry or replace history.
        return runtime?.addCost(m.usd);
      case "set-model":
        return runtime?.setModel(m.provider, m.model);
      case "session-start":
        void (async () => {
          try {
            const ev = await runtime?.sessionStart();
            port.postMessage({ t: "reply", cid: m.cid, ok: true, value: ev ?? null } satisfies ToHost);
          } catch (err) {
            port.postMessage({ t: "reply", cid: m.cid, ok: false, error: String(err) } satisfies ToHost);
          }
        })();
        return;
      case "reply": {
        const c = calls.get(m.cid);
        calls.delete(m.cid);
        if (m.ok) c?.resolve(m.value);
        else c?.reject(new Error(m.error));
        return;
      }
      case "stream-event":
        return streams.get(m.sid)?.push(m.ev);
      case "stream-end":
        return streams.get(m.sid)?.end();
      case "stream-error": {
        const err = Object.assign(new Error(m.error), { name: m.name ?? "Error", retryable: m.retryable });
        return streams.get(m.sid)?.fail(err);
      }
    }
  };
  port.start?.();
}

// ============================== host (main thread) side ==============================

export interface RemoteHostDeps {
  gateway: ModelGateway;
  tools: ToolHost;
  gate?: PermissionGate;
  hooks?: HookRunner;
  sections?: () => ContextSection[] | Promise<ContextSection[]>;
  verify?: { enabled(): boolean; maxAttempts?: number; root: string; run: NonNullable<RuntimeDeps["verify"]>["run"] };
  modePrompt?: (mode: Mode) => string | undefined;
  audit?: (entry: { kind: "model" | "tool"; name: string; detail?: string }) => void;
}

/** Same surface the UI uses on `Runtime`, backed by a worker. */
export class RuntimeClient implements AgentRuntime {
  history: Message[] = [];
  costUsd = 0;
  summaries: string[] = [];
  running = false;
  transport = "worker";
  private lastMeter: RuntimeSnapshot["meter"] = { total: 0, entries: [], ratio: 1, calibrated: false, lastReported: 0 };
  private nextRid = 1;
  private nextCid = 1;
  private runs = new Map<number, { push: (x: { ev?: AgentEvent; end?: RuntimeSnapshot; error?: Error }) => void }>();
  private sessionStarts = new Map<number, (v: AgentEvent | null) => void>();
  private streamAborts = new Map<number, AbortController>();
  readonly ready: Promise<void>;

  constructor(private port: Port, private deps: RemoteHostDeps, config: RuntimeConfig) {
    let resolveReady!: () => void;
    this.ready = new Promise<void>((r) => (resolveReady = r));
    port.onmessage = (e) => void this.onMessage(e.data as ToHost, resolveReady);
    port.start?.();
    const toolSpecs = Object.fromEntries(MODES.map((m) => [m, deps.tools.listTools(m)])) as Record<Mode, ToolSpec[]>;
    const modePrompts = Object.fromEntries(MODES.map((m) => [m, deps.modePrompt?.(m)])) as Record<Mode, string | undefined>;
    const init: InitMessage = {
      t: "init",
      config,
      toolSpecs,
      modePrompts,
      verify: deps.verify ? { enabled: deps.verify.enabled(), maxAttempts: deps.verify.maxAttempts, root: deps.verify.root } : null,
      hasHooks: !!deps.hooks,
      hasGate: !!deps.gate,
      hasSections: !!deps.sections,
    };
    port.postMessage(init);
  }

  private post(m: ToWorker) {
    this.port.postMessage(m);
  }

  private apply(s: RuntimeSnapshot) {
    this.history = s.history;
    this.costUsd = s.costUsd;
    this.summaries = s.summaries;
    this.lastMeter = s.meter;
    this.running = s.running;
  }

  private async onMessage(m: ToHost, ready: () => void) {
    switch (m.t) {
      case "ready":
        return ready();
      case "event":
        return this.runs.get(m.rid)?.push({ ev: m.ev });
      case "end":
        return this.runs.get(m.rid)?.push({ end: m.snapshot });
      case "error":
        return this.runs.get(m.rid)?.push({ error: Object.assign(new Error(m.error), { name: m.name ?? "Error", retryable: m.retryable }) });
      case "audit":
        return this.deps.audit?.(m.entry);
      case "reply":
        return this.sessionStarts.get(m.cid)?.((m.ok ? (m.value as AgentEvent | null) : null) ?? null);
      case "stream-abort":
        return this.streamAborts.get(m.sid)?.abort();
      case "stream": {
        const ac = new AbortController();
        this.streamAborts.set(m.sid, ac);
        try {
          for await (const ev of this.deps.gateway.stream({ ...m.req, signal: ac.signal })) this.post({ t: "stream-event", sid: m.sid, ev });
          this.post({ t: "stream-end", sid: m.sid });
        } catch (e) {
          const x = e as { message?: string; name?: string; retryable?: boolean };
          this.post({ t: "stream-error", sid: m.sid, error: x?.message ?? String(e), name: x?.name, retryable: x?.retryable });
        } finally {
          this.streamAborts.delete(m.sid);
        }
        return;
      }
      case "call": {
        try {
          const d = this.deps;
          let value: unknown;
          switch (m.method) {
            case "tools.call":
              value = await d.tools.call(m.args[0] as Mode, m.args[1] as ToolCall);
              break;
            case "gate.check":
              value = await d.gate!.check(m.args[0] as never, m.args[1] as ToolCall);
              break;
            case "sections":
              value = (await d.sections?.()) ?? [];
              break;
            case "verify.run":
              value = await d.verify!.run(m.args[0] as never, m.args[1] as never, m.args[2] as number);
              break;
            case "hooks.run":
              value = await d.hooks!.run(m.args[0] as never, m.args[1] as never);
              break;
          }
          this.post({ t: "reply", cid: m.cid, ok: true, value });
        } catch (e) {
          this.post({ t: "reply", cid: m.cid, ok: false, error: e instanceof Error ? e.message : String(e) });
        }
      }
    }
  }

  async *run(req: { mode: Mode; prompt: string; signal?: AbortSignal }): AsyncIterable<AgentEvent> {
    await this.ready;
    const rid = this.nextRid++;
    const queue: { ev?: AgentEvent; end?: RuntimeSnapshot; error?: Error }[] = [];
    let wake: (() => void) | null = null;
    this.runs.set(rid, {
      push: (x) => {
        queue.push(x);
        wake?.();
      },
    });
    this.running = true;
    req.signal?.addEventListener("abort", () => this.post({ t: "abort", rid }), { once: true });
    this.post({ t: "run", rid, req: { mode: req.mode, prompt: req.prompt } });
    try {
      for (;;) {
        while (queue.length === 0) await new Promise<void>((r) => (wake = r));
        wake = null;
        const x = queue.shift()!;
        if (x.error) throw x.error;
        if (x.end) return void this.apply(x.end);
        yield x.ev!;
      }
    } finally {
      this.runs.delete(rid);
      this.running = false;
    }
  }

  meter() {
    return this.lastMeter;
  }

  setModel(provider: string, model: string) {
    this.post({ t: "set-model", provider, model });
  }

  /** Replace the conversation (restore to a checkpoint, resume a session). */
  setHistory(history: Message[]) {
    this.history = history;
    this.post({ t: "set-history", history });
  }

  addCost(usd: number) {
    this.costUsd += usd;
    this.post({ t: "add-cost", usd });
  }

  async sessionStart(): Promise<AgentEvent | null> {
    await this.ready;
    return new Promise((resolve) => {
      const cid = this.nextCid++;
      this.sessionStarts.set(cid, resolve);
      this.post({ t: "session-start", cid });
    });
  }

  terminate() {
    this.port.close?.();
  }
}
