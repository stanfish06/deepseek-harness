/**
 * Langfuse exporter tracing
 */

import { createHash } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import type {
  EpochHeader,
  RequestContext,
  Session,
  SessionEvent,
  SessionId,
} from "@deepseek-ai/dsh-session";
import {
  APP_IDENTITY,
  assistantStreamFirstTokenTime,
  type ContentBlock,
  type Message,
  type TokenUsage,
} from "@deepseek-ai/dsh-llm";
import { getOrCreateAnonymousUserId } from "@deepseek-ai/dsh-anonymous-user-id";
import type {} from "@deepseek-ai/dsh-llm-retry";
import type {} from "@deepseek-ai/dsh-session-title";
import type {} from "@deepseek-ai/dsh-compaction";
import type {} from "@deepseek-ai/dsh-plan-mode";
import type {} from "@deepseek-ai/dsh-tool-todo";
import type {} from "@deepseek-ai/dsh-command-feedback";
import type {} from "@deepseek-ai/dsh-message-feedback";
import type {} from "@deepseek-ai/dsh-user-approval";
import type { Span, SpanContext } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import {
  LangfuseOtelSpanAttributes,
  setLangfuseTracerProvider,
  startObservation,
  type LangfuseAgent,
  type LangfuseGeneration,
  type LangfuseGenerationAttributes,
  type LangfuseGuardrail,
  type LangfuseSpan,
  type LangfuseSpanAttributes,
  type LangfuseTool,
} from "@langfuse/tracing";
import { LangfuseClient } from "@langfuse/client";

export const name = "langfuse";

export interface Config {
  publicKeyEnv?: string;
  secretKeyEnv?: string;
  baseUrlEnv?: string;
  environment?: string;
  release?: string;
  exportMode?: "batched" | "immediate";
  flushAt?: number;
  flushInterval?: number;
  captureContent?: boolean;
  tags?: string[];
  shutdownTimeoutMillis?: number;
}

export const Config: z<Config> = z.object({
  publicKeyEnv: z.string(),
  secretKeyEnv: z.string(),
  baseUrlEnv: z.string(),
  environment: z.string(),
  release: z.string(),
  exportMode: z.union(["batched", "immediate"]),
  flushAt: z.number(),
  flushInterval: z.number(),
  captureContent: z.boolean(),
  tags: z.array(z.string()),
  shutdownTimeoutMillis: z.number(),
});

interface Resolved {
  publicKeyEnv: string;
  secretKeyEnv: string;
  baseUrlEnv: string;
  environment: string | undefined;
  release: string;
  exportMode: "batched" | "immediate";
  flushAt: number | undefined;
  flushInterval: number | undefined;
  captureContent: boolean;
  tags: string[];
  shutdownTimeoutMillis: number;
}

function resolve(config: Config): Resolved {
  const shutdownTimeoutMillis = config.shutdownTimeoutMillis ?? 3_000;
  if (!Number.isInteger(shutdownTimeoutMillis) || shutdownTimeoutMillis <= 0)
    throw new Error(
      `langfuse: shutdownTimeoutMillis must be a positive integer, got ${JSON.stringify(shutdownTimeoutMillis)}`,
    );
  return {
    publicKeyEnv: config.publicKeyEnv ?? DEFAULT_CONNECTION_ENV.publicKeyEnv,
    secretKeyEnv: config.secretKeyEnv ?? DEFAULT_CONNECTION_ENV.secretKeyEnv,
    baseUrlEnv: config.baseUrlEnv ?? DEFAULT_CONNECTION_ENV.baseUrlEnv,
    environment: config.environment,
    release: config.release ?? APP_IDENTITY.version,
    exportMode: config.exportMode ?? "batched",
    flushAt: config.flushAt,
    flushInterval: config.flushInterval,
    captureContent: config.captureContent ?? true,
    tags: config.tags ?? [],
    shutdownTimeoutMillis,
  };
}

type Chat = Record<string, unknown>;

interface ToolState {
  obs: LangfuseTool;
  name: string;
}

interface StepState {
  step: number;
  span: LangfuseSpan;
  start: number;
  requestStart: number | undefined;
  tools: Map<string, ToolState>;
}

interface TurnState {
  turn: number;
  root: LangfuseAgent;
  traceId: string;
  steps: Map<number, StepState>;
  current: StepState | undefined;
  hasInput: boolean;
  lastAssistantText: string | undefined;
}

interface SessionState {
  rootId: SessionId;
  turns: Map<number, TurnState>;
  title: string | undefined;
  header: EpochHeader | undefined;
  context: RequestContext | undefined;
  planActive: boolean;
  approvals: Map<string, LangfuseGuardrail>;
  generations: Map<string, { traceId: string; observationId: string }>;
}

const ROOT_PARENT_SPAN_ID = "0000000000000001";
const MAX_TEXT_SCORE = 500;

function traceIdFor(seed: string): string {
  return createHash("sha256").update(seed).digest("hex").slice(0, 32);
}

function readEnv(key: string): string {
  const value = process.env[key]?.trim();
  if (value === undefined || value === "")
    throw new Error(`langfuse: environment variable ${key} is not set`);
  return value;
}

/** Local langfuse credentials */
export interface Connection {
  publicKey: string;
  secretKey: string;
  baseUrl: string;
}

/** Environment variables */
export interface ConnectionEnv {
  publicKeyEnv: string;
  secretKeyEnv: string;
  baseUrlEnv: string;
}

export const DEFAULT_CONNECTION_ENV: ConnectionEnv = {
  publicKeyEnv: "LANGFUSE_PUBLIC_KEY",
  secretKeyEnv: "LANGFUSE_SECRET_KEY",
  baseUrlEnv: "LANGFUSE_BASE_URL",
};

/**
 * Read the connection from the process environment; fails loud on any
 * missing variable.
 * @param env - variable names to read.
 * @returns the resolved connection.
 */
export function readConnection(env: ConnectionEnv): Connection {
  return {
    publicKey: readEnv(env.publicKeyEnv),
    secretKey: readEnv(env.secretKeyEnv),
    baseUrl: readEnv(env.baseUrlEnv),
  };
}

function textOf(blocks: readonly ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case "text":
        parts.push(block.text);
        break;
      case "image":
        parts.push("[image]");
        break;
      case "file":
        parts.push("[file]");
        break;
      case "tool-result":
        parts.push(textOf(block.content));
        break;
      default:
        // reasoning and tool-call blocks are projected as separate chat fields
        break;
    }
  }
  return parts.join("\n");
}

// OpenAI-style chat message so Langfuse renders the transcript as chat cards.
function toChat(message: Message): Chat {
  if (message.role === "system")
    return { role: "system", content: textOf(message.content) };
  if (message.role === "assistant") {
    const toolCalls: Chat[] = [];
    const reasoning: string[] = [];
    for (const block of message.content) {
      if (block.type === "tool-call")
        toolCalls.push({
          id: block.id,
          type: "function",
          function: { name: block.name, arguments: block.arguments },
        });
      else if (block.type === "reasoning") reasoning.push(block.text);
    }
    return {
      role: "assistant",
      content: textOf(message.content),
      ...(reasoning.length > 0
        ? { reasoning_content: reasoning.join("\n") }
        : {}),
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    };
  }
  if (message.source.kind === "tool")
    return {
      role: "tool",
      tool_call_id: message.source.callId,
      content: textOf(message.content),
    };
  return {
    role: "user",
    content: textOf(message.content),
    ...(message.source.kind === "plugin"
      ? { name: message.source.plugin }
      : {}),
  };
}

function usageDetails(usage: TokenUsage): Record<string, number> {
  const reasoning = usage.reasoningTokens ?? 0;
  const details: Record<string, number> = {
    input: usage.inputTokens,
    output: Math.max(0, usage.outputTokens - reasoning),
  };
  if (usage.cacheReadTokens !== undefined)
    details.input_cached_tokens = usage.cacheReadTokens;
  if (usage.cacheWriteTokens !== undefined)
    details.input_cache_write_tokens = usage.cacheWriteTokens;
  if (usage.reasoningTokens !== undefined)
    details.output_reasoning_tokens = usage.reasoningTokens;
  if (usage.totalTokens !== undefined) details.total = usage.totalTokens;
  return details;
}

function modelParameters(
  header: EpochHeader | undefined,
): Record<string, string | number> | undefined {
  if (header === undefined) return undefined;
  const { temperature, maxTokens, reasoningEffort, stop } = header.config;
  const params: Record<string, string | number> = {};
  if (temperature !== undefined) params.temperature = temperature;
  if (maxTokens !== undefined) params.max_tokens = maxTokens;
  if (reasoningEffort !== undefined)
    params.reasoning_effort = String(reasoningEffort);
  if (stop !== undefined && stop.length > 0) params.stop = stop.join(",");
  return Object.keys(params).length > 0 ? params : undefined;
}

function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    // the model produced malformed JSON; keep the raw string
    return raw;
  }
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function apply(ctx: Context, config: Config = {}): void {
  const opts = resolve(config);
  const { publicKey, secretKey, baseUrl } = readConnection(opts);
  const userId = String(getOrCreateAnonymousUserId());
  const capture = opts.captureContent;

  const processor = new LangfuseSpanProcessor({
    publicKey,
    secretKey,
    baseUrl,
    release: opts.release,
    exportMode: opts.exportMode,
    ...(opts.environment !== undefined
      ? { environment: opts.environment }
      : {}),
    ...(opts.flushAt !== undefined ? { flushAt: opts.flushAt } : {}),
    ...(opts.flushInterval !== undefined
      ? { flushInterval: opts.flushInterval }
      : {}),
  });
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      "service.name": APP_IDENTITY.product,
      "service.version": APP_IDENTITY.version,
    }),
    spanProcessors: [processor],
  });
  setLangfuseTracerProvider(provider);
  const client = new LangfuseClient({ publicKey, secretKey, baseUrl });

  const sessions = new Map<SessionId, SessionState>();

  const stateFor = (session: Session): SessionState => {
    let state = sessions.get(session.id);
    if (state !== undefined) return state;
    const parent =
      session.header.origin === "subagent" &&
      session.header.parentSession !== undefined
        ? sessions.get(session.header.parentSession)
        : undefined;
    state = {
      rootId: parent?.rootId ?? session.id,
      turns: new Map(),
      title: undefined,
      header: undefined,
      context: undefined,
      planActive: false,
      approvals: new Map(),
      generations: new Map(),
    };
    sessions.set(session.id, state);
    return state;
  };

  const openTurn = (state: SessionState): TurnState | undefined => {
    let latest: TurnState | undefined;
    for (const turn of state.turns.values())
      if (latest === undefined || turn.turn > latest.turn) latest = turn;
    return latest;
  };

  const parentContextFor = (session: Session): SpanContext | undefined => {
    if (
      session.header.origin !== "subagent" ||
      session.header.parentSession === undefined
    )
      return undefined;
    const parentState = sessions.get(session.header.parentSession);
    const turn = parentState === undefined ? undefined : openTurn(parentState);
    if (turn === undefined) return undefined;
    const step = turn.current;
    if (step === undefined) return turn.root.otelSpan.spanContext();
    const tool = [...step.tools.values()].at(-1);
    return (tool?.obs ?? step.span).otelSpan.spanContext();
  };

  const inTrace = <T extends { otelSpan: Span }>(
    session: Session,
    state: SessionState,
    fn: () => T,
  ): T => {
    const obs = fn();
    const attributes: Record<string, string | string[]> = {
      [LangfuseOtelSpanAttributes.TRACE_SESSION_ID]: String(state.rootId),
      [LangfuseOtelSpanAttributes.TRACE_USER_ID]: userId,
      [`${LangfuseOtelSpanAttributes.TRACE_METADATA}.dsh_session`]: String(
        session.id,
      ),
      [`${LangfuseOtelSpanAttributes.TRACE_METADATA}.dsh_version`]:
        APP_IDENTITY.version,
    };
    if (session.header.cwd !== undefined)
      attributes[`${LangfuseOtelSpanAttributes.TRACE_METADATA}.cwd`] = clip(
        session.header.cwd,
        200,
      );
    if (session.header.agentPreset !== undefined)
      attributes[`${LangfuseOtelSpanAttributes.TRACE_METADATA}.agent_preset`] =
        session.header.agentPreset;
    if (session.header.parentSession !== undefined)
      attributes[
        `${LangfuseOtelSpanAttributes.TRACE_METADATA}.parent_session`
      ] = String(session.header.parentSession);
    if (state.title !== undefined)
      attributes[LangfuseOtelSpanAttributes.TRACE_NAME] = state.title;
    const tags = [...opts.tags];
    if (state.planActive) tags.push("plan");
    if (session.header.origin === "subagent") tags.push("subagent");
    if (tags.length > 0)
      attributes[LangfuseOtelSpanAttributes.TRACE_TAGS] = tags;
    obs.otelSpan.setAttributes(attributes);
    return obs;
  };

  const at = (time: number): Date => new Date(time);

  const spanUnder = (
    session: Session,
    state: SessionState,
    parent: SpanContext,
    label: string,
    attributes: LangfuseSpanAttributes,
    time: number,
  ): LangfuseSpan =>
    inTrace(session, state, () =>
      startObservation(label, attributes, {
        asType: "span",
        startTime: at(time),
        parentSpanContext: parent,
      }),
    );

  const eventUnder = (
    session: Session,
    state: SessionState,
    parent: SpanContext,
    label: string,
    attributes: LangfuseSpanAttributes,
    time: number,
  ): void => {
    inTrace(session, state, () =>
      startObservation(label, attributes, {
        asType: "event",
        startTime: at(time),
        parentSpanContext: parent,
      }),
    );
  };

  const generationUnder = (
    session: Session,
    state: SessionState,
    parent: SpanContext,
    label: string,
    attributes: LangfuseGenerationAttributes,
    start: number,
    end: number,
  ): LangfuseGeneration => {
    const generation = inTrace(session, state, () =>
      startObservation(label, attributes, {
        asType: "generation",
        startTime: at(start),
        parentSpanContext: parent,
      }),
    );
    generation.end(at(end));
    return generation;
  };

  const anchorOf = (turn: TurnState): SpanContext =>
    (turn.current?.span ?? turn.root).otelSpan.spanContext();

  const endStep = (step: StepState, time: number, reason?: string): void => {
    for (const tool of step.tools.values()) {
      tool.obs
        .update({
          level: "WARNING",
          statusMessage: reason ?? "tool result never recorded",
        })
        .end(at(time));
    }
    step.tools.clear();
    step.span.end(at(time));
  };

  const endTurn = (
    state: SessionState,
    turn: TurnState,
    time: number,
    attributes: LangfuseSpanAttributes,
  ): void => {
    if (turn.current !== undefined) {
      endStep(turn.current, time, attributes.statusMessage);
      turn.current = undefined;
    }
    turn.root
      .update({
        ...attributes,
        ...(capture && turn.lastAssistantText !== undefined
          ? { output: turn.lastAssistantText }
          : {}),
      })
      .end(at(time));
    state.turns.delete(turn.turn);
  };

  const requestInput = (session: Session, assistantId: string): Chat[] => {
    const messages = session.deriveMessages();
    const last = messages.at(-1);
    if (last !== undefined && last.id === assistantId) messages.pop();
    return messages.map(toChat);
  };

  const onEvent = (session: Session, event: SessionEvent): void => {
    const state = stateFor(session);
    switch (event.type) {
      case "turn/start": {
        const { turn } = event.data;
        const parent = parentContextFor(session);
        const traceId =
          parent?.traceId ?? traceIdFor(`${String(session.id)}:${turn}`);
        const root = inTrace(session, state, () =>
          startObservation(
            `turn ${turn}`,
            { metadata: { turn } },
            {
              asType: "agent",
              startTime: at(event.time),
              parentSpanContext: parent ?? {
                traceId,
                spanId: ROOT_PARENT_SPAN_ID,
                traceFlags: 1,
              },
            },
          ),
        );
        if (parent === undefined && state.title === undefined)
          root.otelSpan.setAttribute(
            LangfuseOtelSpanAttributes.TRACE_NAME,
            `turn ${turn}`,
          );
        state.turns.set(turn, {
          turn,
          root,
          traceId,
          steps: new Map(),
          current: undefined,
          hasInput: false,
          lastAssistantText: undefined,
        });
        return;
      }
      case "turn/end": {
        const turn = state.turns.get(event.data.turn);
        if (turn === undefined) return;
        const { reason } = event.data;
        const attributes: LangfuseSpanAttributes = {
          metadata: { turn: turn.turn, end_reason: reason.kind },
        };
        switch (reason.kind) {
          case "completed":
            break;
          case "error":
            attributes.level = "ERROR";
            attributes.statusMessage = `${reason.error.code}: ${reason.error.message}`;
            break;
          default:
            attributes.level = "WARNING";
            attributes.statusMessage = reason.kind;
        }
        endTurn(state, turn, event.time, attributes);
        return;
      }
      case "step/start": {
        const turn = state.turns.get(event.data.turn);
        if (turn === undefined) return;
        const span = spanUnder(
          session,
          state,
          turn.root.otelSpan.spanContext(),
          `step ${event.data.step}`,
          { metadata: { turn: turn.turn, step: event.data.step } },
          event.time,
        );
        const step: StepState = {
          step: event.data.step,
          span,
          start: event.time,
          requestStart: undefined,
          tools: new Map(),
        };
        turn.steps.set(event.data.step, step);
        turn.current = step;
        return;
      }
      case "step/end": {
        const turn = state.turns.get(event.data.turn);
        const step = turn?.steps.get(event.data.step);
        if (turn === undefined || step === undefined) return;
        endStep(step, event.time);
        turn.steps.delete(event.data.step);
        if (turn.current === step) turn.current = undefined;
        return;
      }
      case "request/header": {
        state.header = event.data.header;
        const step = openTurn(state)?.current;
        if (step !== undefined) step.requestStart = event.time;
        return;
      }
      case "request/context":
        state.context = event.data;
        return;
      case "user/message": {
        const turn = openTurn(state);
        if (
          turn === undefined ||
          turn.hasInput ||
          event.data.source.kind !== "user"
        )
          return;
        turn.hasInput = true;
        if (capture) turn.root.update({ input: textOf(event.data.content) });
        return;
      }
      case "assistant/message": {
        const turn = state.turns.get(event.data.turn);
        if (turn === undefined) return;
        const step = turn.steps.get(event.data.step);
        const { message, stream, usage, interrupted } = event.data;
        const firstToken = assistantStreamFirstTokenTime(stream);
        const start =
          step?.requestStart ?? step?.start ?? firstToken ?? event.time;
        const text = textOf(message.content);
        if (text !== "") turn.lastAssistantText = text;
        const params = modelParameters(state.header);
        const attributes: LangfuseGenerationAttributes = {
          model: message.source.model,
          ...(params !== undefined ? { modelParameters: params } : {}),
          metadata: {
            provider: message.source.provider,
            turn: turn.turn,
            step: event.data.step,
            ...(state.context?.contextWindow !== undefined
              ? { context_window: state.context.contextWindow }
              : {}),
          },
          ...(usage !== undefined ? { usageDetails: usageDetails(usage) } : {}),
          ...(firstToken !== undefined
            ? { completionStartTime: at(firstToken) }
            : {}),
          ...(interrupted === true
            ? { level: "WARNING", statusMessage: "interrupted" }
            : {}),
          ...(capture
            ? {
                input: requestInput(session, message.id),
                output: toChat(message),
              }
            : {}),
        };
        const generation = generationUnder(
          session,
          state,
          (step?.span ?? turn.root).otelSpan.spanContext(),
          message.source.model,
          attributes,
          start,
          event.time,
        );
        if (step !== undefined) step.requestStart = undefined;
        state.generations.set(String(message.id), {
          traceId: generation.traceId,
          observationId: generation.id,
        });
        return;
      }
      case "assistant/attempt": {
        const turn = state.turns.get(event.data.turn);
        if (turn === undefined) return;
        const step = turn.steps.get(event.data.step);
        const firstToken = assistantStreamFirstTokenTime(event.data.stream);
        generationUnder(
          session,
          state,
          (step?.span ?? turn.root).otelSpan.spanContext(),
          state.header?.config.model ?? "attempt",
          {
            ...(state.header !== undefined
              ? { model: state.header.config.model }
              : {}),
            level: "ERROR",
            statusMessage: "attempt committed no message",
            metadata: { turn: turn.turn, step: event.data.step },
            ...(firstToken !== undefined
              ? { completionStartTime: at(firstToken) }
              : {}),
          },
          step?.requestStart ?? step?.start ?? firstToken ?? event.time,
          event.time,
        );
        return;
      }
      case "llm/retry": {
        const turn = state.turns.get(event.data.turn);
        if (turn === undefined) return;
        const { failure, retry, delayMs, provider: route } = event.data;
        eventUnder(
          session,
          state,
          anchorOf(turn),
          `retry ${retry}`,
          {
            level: "WARNING",
            statusMessage: `${failure.code}: ${failure.message}`,
            metadata: {
              provider: route,
              delay_ms: delayMs,
              ...(failure.status !== undefined
                ? { status: failure.status }
                : {}),
            },
          },
          event.time,
        );
        return;
      }
      case "tool/call": {
        const turn = state.turns.get(event.data.turn);
        const step = turn?.steps.get(event.data.step);
        if (turn === undefined || step === undefined) return;
        const obs = inTrace(session, state, () =>
          startObservation(
            event.data.name,
            {
              metadata: { call_id: event.data.callId },
              ...(capture
                ? { input: parseArguments(event.data.arguments) }
                : {}),
            },
            {
              asType: "tool",
              startTime: at(event.time),
              parentSpanContext: step.span.otelSpan.spanContext(),
            },
          ),
        );
        step.tools.set(String(event.data.callId), {
          obs,
          name: event.data.name,
        });
        return;
      }
      case "tool/result": {
        const turn = state.turns.get(event.data.turn);
        const step = turn?.steps.get(event.data.step);
        const [block] = event.data.message.content;
        const key = String(block.toolCallId);
        const pending = step?.tools.get(key);
        const attributes: LangfuseSpanAttributes = {
          ...(capture ? { output: textOf(block.content) } : {}),
          ...(event.data.meta !== undefined && capture
            ? { metadata: { meta: event.data.meta } }
            : {}),
        };
        if (block.isError === true) {
          attributes.level = "ERROR";
          attributes.statusMessage =
            event.data.error !== undefined
              ? `${event.data.error.name} (${event.data.error.code})`
              : "tool error";
        }
        if (pending !== undefined && step !== undefined) {
          pending.obs.update(attributes).end(at(event.time));
          step.tools.delete(key);
          return;
        }
        if (turn === undefined) return;
        inTrace(session, state, () =>
          startObservation(`tool ${key}`, attributes, {
            asType: "tool",
            startTime: at(event.time),
            parentSpanContext: anchorOf(turn),
          }),
        ).end(at(event.time));
        return;
      }
      case "approval/asked": {
        const turn = openTurn(state);
        if (turn === undefined) return;
        const obs = inTrace(session, state, () =>
          startObservation(
            `approval ${event.data.toolName}`,
            {
              input: {
                tool: event.data.toolName,
                ...(event.data.callId !== undefined
                  ? { call_id: event.data.callId }
                  : {}),
                ...(event.data.reason !== undefined
                  ? { reason: event.data.reason }
                  : {}),
              },
            },
            {
              asType: "guardrail",
              startTime: at(event.time),
              parentSpanContext: anchorOf(turn),
            },
          ),
        );
        state.approvals.set(String(event.data.id), obs);
        return;
      }
      case "approval/decided": {
        const obs = state.approvals.get(String(event.data.id));
        if (obs === undefined) return;
        state.approvals.delete(String(event.data.id));
        obs.update({ output: event.data.outcome }).end(at(event.time));
        return;
      }
      case "compaction/summary": {
        const {
          provider: route,
          model,
          usage,
          maxTokens,
          shadowedTokenCount,
        } = event.data;
        const turn = openTurn(state);
        // Manual compaction between turns gets its own trace.
        const parent: SpanContext =
          turn !== undefined
            ? anchorOf(turn)
            : {
                traceId: traceIdFor(
                  `${String(session.id)}:compaction:${String(event.data.compactionId)}`,
                ),
                spanId: ROOT_PARENT_SPAN_ID,
                traceFlags: 1,
              };
        generationUnder(
          session,
          state,
          parent,
          "compaction",
          {
            model,
            ...(maxTokens !== undefined
              ? { modelParameters: { max_tokens: maxTokens } }
              : {}),
            metadata: {
              provider: route,
              shadowed_tokens: shadowedTokenCount,
              shadowed_events: event.data.shadowedSeqs.length,
            },
            ...(usage !== undefined
              ? { usageDetails: usageDetails(usage) }
              : {}),
            ...(capture ? { output: textOf(event.data.summary) } : {}),
          },
          event.time,
          event.time,
        );
        return;
      }
      case "session/title":
        // Applies to traces created from now on; propagated attributes are fixed at span start.
        state.title = event.data.title;
        return;
      case "plan/mode": {
        state.planActive = event.data.active;
        const turn = openTurn(state);
        if (turn === undefined) return;
        eventUnder(
          session,
          state,
          anchorOf(turn),
          event.data.active ? "plan mode on" : "plan mode off",
          {},
          event.time,
        );
        return;
      }
      case "todo/write": {
        const turn = openTurn(state);
        if (turn === undefined) return;
        eventUnder(
          session,
          state,
          anchorOf(turn),
          "todo",
          {
            ...(capture ? { output: event.data.todos } : {}),
            metadata: {
              total: event.data.todos.length,
              completed: event.data.todos.filter(
                (t) => t.status === "completed",
              ).length,
            },
          },
          event.time,
        );
        return;
      }
      case "feedback/message-put": {
        const { item } = event.data;
        const target = state.generations.get(String(item.messageId));
        if (target === undefined) return;
        client.score.create({
          id: `${String(session.id)}:${String(item.messageId)}`,
          traceId: target.traceId,
          observationId: target.observationId,
          name: "user-rating",
          value: item.rating === "positive" ? 1 : 0,
          dataType: "BOOLEAN",
          ...(item.note !== undefined && capture ? { comment: item.note } : {}),
          ...(item.category !== undefined
            ? { metadata: { category: item.category } }
            : {}),
        });
        return;
      }
      case "feedback/record": {
        const { text, category } = event.data;
        client.score.create({
          sessionId: String(state.rootId),
          name: "session-feedback",
          ...(text !== undefined && capture
            ? { value: clip(text, MAX_TEXT_SCORE), dataType: "TEXT" }
            : {
                value: category ?? "review-requested",
                dataType: "CATEGORICAL",
              }),
          ...(category !== undefined ? { metadata: { category } } : {}),
        });
        return;
      }
      default:
        // merge-extensible map: unknown and non-traced event types fall through
        return;
    }
  };

  ctx.on("session/event", (session: Session, event: SessionEvent) => {
    try {
      onEvent(session, event);
    } catch (error) {
      ctx.logger.warn(
        `langfuse: ${event.type} at seq ${String(event.seq)} not exported: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  });

  ctx.on("session/disposed", (session: Session) => {
    const state = sessions.get(session.id);
    if (state === undefined) return;
    const now = Date.now();
    for (const turn of [...state.turns.values()])
      endTurn(state, turn, now, {
        level: "WARNING",
        statusMessage: "session disposed before turn end",
      });
    for (const obs of state.approvals.values())
      obs.update({ level: "WARNING", statusMessage: "undecided" }).end(at(now));
    sessions.delete(session.id);
  });

  // The loop awaits this checkpoint; kick the export without holding it.
  ctx.on("session/flush", () => {
    processor.forceFlush().catch((error: unknown) => {
      ctx.logger.warn(
        `langfuse: flush failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  });

  ctx.effect(
    () => async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `langfuse: shutdown exceeded ${opts.shutdownTimeoutMillis}ms`,
              ),
            ),
          opts.shutdownTimeoutMillis,
        );
      });
      try {
        await Promise.race([
          Promise.all([client.shutdown(), provider.shutdown()]),
          deadline,
        ]);
      } catch (error) {
        ctx.logger.warn(error instanceof Error ? error.message : String(error));
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        setLangfuseTracerProvider(null);
      }
    },
    "langfuse.provider",
  );

  ctx.logger.info(
    `langfuse: exporting to ${baseUrl} (environment ${opts.environment ?? "default"}, content ${capture ? "on" : "off"})`,
  );
}
