/**
 * Tool to query trace data from langfuse
 */

import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { JsonValue } from "@deepseek-ai/dsh-util-values";
import { LangfuseClient } from "@langfuse/client";
import {
  DEFAULT_CONNECTION_ENV,
  readConnection,
  type ConnectionEnv,
} from "./langfuse.ts";

export const name = "langfuse-query";
export const inject = ["tools"];

export interface Config extends Partial<ConnectionEnv> {
  maxLimit?: number;
}

export const Config: z<Config> = z.object({
  publicKeyEnv: z.string(),
  secretKeyEnv: z.string(),
  baseUrlEnv: z.string(),
  maxLimit: z.number(),
});

interface Resolved extends ConnectionEnv {
  maxLimit: number;
}

function resolve(config: Config): Resolved {
  const maxLimit = config.maxLimit ?? 50;
  if (!Number.isInteger(maxLimit) || maxLimit <= 0)
    throw new Error(
      `langfuse-query: maxLimit must be a positive integer, got ${JSON.stringify(maxLimit)}`,
    );
  return {
    publicKeyEnv: config.publicKeyEnv ?? DEFAULT_CONNECTION_ENV.publicKeyEnv,
    secretKeyEnv: config.secretKeyEnv ?? DEFAULT_CONNECTION_ENV.secretKeyEnv,
    baseUrlEnv: config.baseUrlEnv ?? DEFAULT_CONNECTION_ENV.baseUrlEnv,
    maxLimit,
  };
}

const RESOURCES = [
  "observations",
  "traces",
  "sessions",
  "scores",
  "metrics",
] as const;
const OBSERVATION_TYPES = [
  "GENERATION",
  "SPAN",
  "TOOL",
  "AGENT",
  "EVENT",
  "GUARDRAIL",
] as const;
const LEVELS = ["DEBUG", "DEFAULT", "WARNING", "ERROR"] as const;

// Observation fields kept when `includeIo` is false; input/output/metadata
// carry whole transcripts and would flood the model context.
const OBSERVATION_SUMMARY_FIELDS = [
  "id",
  "traceId",
  "parentObservationId",
  "type",
  "name",
  "startTime",
  "endTime",
  "latency",
  "timeToFirstToken",
  "level",
  "statusMessage",
  "model",
  "usageDetails",
  "costDetails",
  "totalCost",
  "sessionId",
  "userId",
  "environment",
] as const;

type JsonRecord = Record<string, unknown>;

const asJson = (value: unknown): JsonValue => value as JsonValue;

function pick(record: JsonRecord, keys: readonly string[]): JsonRecord {
  const out: JsonRecord = {};
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null) out[key] = value;
  }
  return out;
}

function stripIo(record: JsonRecord): JsonRecord {
  const {
    input: _input,
    output: _output,
    metadata: _metadata,
    ...rest
  } = record;
  return rest;
}

export function apply(ctx: Context, config: Config = {}): void {
  const opts = resolve(config);
  const client = new LangfuseClient(readConnection(opts));

  ctx.tools.register(
    defineTool({
      name: "langfuse_query",
      description:
        "Query runtime data this harness exported to Langfuse: observations (model generations, tool calls, steps), traces (one per turn), sessions, scores, or aggregate metrics. " +
        'Use sessionId "current" for the running session. Data appears in Langfuse 15-30 seconds after it is produced, so the current turn is usually not yet visible. ' +
        "The read API below is Langfuse v3 and is deprecated on Langfuse Cloud: it retires 2026-11-16 in favor of the real-time v4 observations API (GET /api/public/v2/observations). " +
        "Until the SDK exposes a v4 client, migration is tracked in the repo; this tool re-uses the connection from the langfuse exporter plugin.",
      parameters: {
        resource: {
          type: "string",
          required: true,
          enum: [...RESOURCES],
          description:
            "observations: rows with model, usage, latency, level (filter by sessionId/traceId/type/name/level). " +
            "traces: one row per turn; with traceId returns the full trace including its observations. " +
            "sessions: list sessions; with sessionId returns the session and its traces. " +
            "scores: user feedback scores. " +
            "metrics: aggregate via metricsQuery.",
        },
        sessionId: {
          type: "string",
          description:
            'Langfuse session id, equal to the dsh session id. "current" = the calling agent\'s session.',
        },
        traceId: { type: "string", description: "Langfuse trace id." },
        userId: { type: "string", description: "Langfuse user id." },
        type: {
          type: "string",
          enum: [...OBSERVATION_TYPES],
          description: "Observation type filter (observations only).",
        },
        name: {
          type: "string",
          description:
            "Observation or trace name filter; tool observations are named after the tool.",
        },
        level: {
          type: "string",
          enum: [...LEVELS],
          description: "Observation level filter (observations only).",
        },
        fromTimestamp: {
          type: "string",
          description: "ISO 8601 lower bound on start time.",
        },
        toTimestamp: {
          type: "string",
          description: "ISO 8601 upper bound on start time.",
        },
        limit: {
          type: "integer",
          description: `Rows to return (default 20, max ${opts.maxLimit}).`,
        },
        includeIo: {
          type: "boolean",
          description:
            "Include observation input, output, and metadata. Default false; these can be very large.",
        },
        metricsQuery: {
          type: "object",
          additionalProperties: true,
          description:
            'Metrics API v2 query (metrics only). Measures: count, latency, streamingLatency, inputTokens, outputTokens, totalTokens, inputCost, outputCost, totalCost, timeToFirstToken, uniqueUserIds, and others. Example: {"view":"observations","metrics":[{"measure":"totalTokens","aggregation":"sum"},{"measure":"inputTokens","aggregation":"sum"},{"measure":"outputTokens","aggregation":"sum"}],"dimensions":[{"field":"providedModelName"}],"filters":[],"fromTimestamp":"2026-09-01T00:00:00Z","toTimestamp":"2026-09-12T00:00:00Z"}. ' +
            'Filters use {"column":"sessionId","operator":"=","value":"<id>","type":"string"}. ' +
            "Unknown measure names return HTTP 400; token measures are inputTokens/outputTokens/totalTokens, never input/output.",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            resource: { type: "string", required: true },
            count: { type: "integer", required: true },
            data: { type: "array", required: true },
            meta: { type: "json" },
          },
        },
        render: (args, value) => [
          {
            type: "text",
            text:
              `${value.resource}: ${value.count} row(s)` +
              (args.includeIo === true ? "" : " (input/output omitted)") +
              "\n" +
              JSON.stringify(value.data, null, 1) +
              (value.meta === undefined
                ? ""
                : `\nmeta: ${JSON.stringify(value.meta)}`),
          },
        ],
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const limit = Math.min(args.limit ?? 20, opts.maxLimit);
        if (limit <= 0)
          throw new Error("langfuse_query: limit must be positive");
        const sessionId =
          args.sessionId === "current"
            ? exec.agent === undefined
              ? undefined
              : String(exec.agent.session.id)
            : args.sessionId;
        if (args.sessionId === "current" && sessionId === undefined)
          throw new Error(
            "langfuse_query: no calling agent; pass an explicit sessionId",
          );
        const range = {
          ...(args.fromTimestamp !== undefined
            ? { fromTimestamp: args.fromTimestamp }
            : {}),
          ...(args.toTimestamp !== undefined
            ? { toTimestamp: args.toTimestamp }
            : {}),
        };
        const requestOptions = { abortSignal: exec.signal };
        const includeIo = args.includeIo === true;
        // v2 observations return only core+basic groups unless asked.
        const fields = [
          "core",
          "basic",
          "time",
          "model",
          "usage",
          "metrics",
          ...(includeIo ? ["io", "metadata"] : []),
        ].join(",");

        switch (args.resource) {
          case "observations": {
            const response = await client.api.observations.getMany(
              {
                limit,
                fields,
                ...(sessionId !== undefined ? { sessionId } : {}),
                ...(args.traceId !== undefined
                  ? { traceId: args.traceId }
                  : {}),
                ...(args.userId !== undefined ? { userId: args.userId } : {}),
                ...(args.type !== undefined ? { type: args.type } : {}),
                ...(args.name !== undefined ? { name: args.name } : {}),
                ...(args.level !== undefined ? { level: args.level } : {}),
                ...range,
              },
              requestOptions,
            );
            const rows = response.data.map((row) => {
              const record = row as unknown as JsonRecord;
              return includeIo
                ? record
                : pick(record, OBSERVATION_SUMMARY_FIELDS);
            });
            return {
              resource: args.resource,
              count: rows.length,
              data: rows.map(asJson),
              meta: asJson(response.meta ?? null),
            };
          }
          case "traces": {
            if (args.traceId !== undefined) {
              const trace = (await client.api.trace.get(
                args.traceId,
                {},
                requestOptions,
              )) as unknown as JsonRecord;
              const observations = Array.isArray(trace.observations)
                ? (trace.observations as JsonRecord[]).map((o) =>
                    includeIo ? o : pick(o, OBSERVATION_SUMMARY_FIELDS),
                  )
                : [];
              const summary = includeIo ? trace : stripIo(trace);
              return {
                resource: args.resource,
                count: 1,
                data: [asJson({ ...summary, observations })],
              };
            }
            const response = await client.api.trace.list(
              {
                limit,
                ...(sessionId !== undefined ? { sessionId } : {}),
                ...(args.userId !== undefined ? { userId: args.userId } : {}),
                ...(args.name !== undefined ? { name: args.name } : {}),
                ...range,
              },
              requestOptions,
            );
            const rows = response.data.map((row) => {
              const record = row as unknown as JsonRecord;
              return includeIo ? record : stripIo(record);
            });
            return {
              resource: args.resource,
              count: rows.length,
              data: rows.map(asJson),
              meta: asJson(response.meta),
            };
          }
          case "sessions": {
            if (sessionId !== undefined) {
              const session = (await client.api.sessions.get(
                sessionId,
                requestOptions,
              )) as unknown as JsonRecord;
              const traces = Array.isArray(session.traces)
                ? (session.traces as JsonRecord[]).map((t) =>
                    includeIo ? t : stripIo(t),
                  )
                : [];
              return {
                resource: args.resource,
                count: 1,
                data: [asJson({ ...session, traces })],
              };
            }
            const response = await client.api.sessions.list(
              { limit, ...range },
              requestOptions,
            );
            return {
              resource: args.resource,
              count: response.data.length,
              data: response.data.map(asJson),
              meta: asJson(response.meta),
            };
          }
          case "scores": {
            const response = await client.api.scoresV3.getManyV3(
              {
                limit,
                ...(sessionId !== undefined ? { sessionId } : {}),
                ...(args.traceId !== undefined
                  ? { traceId: args.traceId }
                  : {}),
                ...(args.userId !== undefined ? { userId: args.userId } : {}),
                ...(args.name !== undefined ? { name: args.name } : {}),
                ...range,
              },
              requestOptions,
            );
            return {
              resource: args.resource,
              count: response.data.length,
              data: response.data.map(asJson),
              meta: asJson(response.meta),
            };
          }
          case "metrics": {
            if (args.metricsQuery === undefined)
              throw new Error(
                "langfuse_query: metricsQuery is required for resource=metrics",
              );
            const response = await client.api.metrics.metrics(
              { query: JSON.stringify(args.metricsQuery) },
              requestOptions,
            );
            return {
              resource: args.resource,
              count: response.data.length,
              data: response.data.map(asJson),
            };
          }
          default:
            throw new Error(
              `langfuse_query: unknown resource ${String(args.resource)}`,
            );
        }
      },
    }),
  );

  ctx.logger.info("langfuse-query: registered tool langfuse_query");
}
