import { execFile } from "node:child_process";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ApprovalRequest } from "@deepseek-ai/dsh-user-approval";
import type { AskUserQuestionRequest } from "@deepseek-ai/dsh-user-questions";
import type {
  ToolExecution,
  ToolExecutionResult,
} from "@deepseek-ai/dsh-tools";

export const name = "notify";

const EVENTS = [
  "idle",
  "approval",
  "question",
  "tool-error",
  "agent-error",
] as const;
type NotifyEvent = (typeof EVENTS)[number];

// arguments for notify-send
export interface Config {
  events?: NotifyEvent[];
  appName?: string;
  promptUrgency?: "low" | "normal" | "critical";
  minTurnMs?: number;
}

function resolve(config: Config): Required<Config> {
  const events = config.events ?? [...EVENTS];
  for (const event of events) {
    if (!EVENTS.includes(event)) {
      throw new Error(
        `notify: unknown event ${JSON.stringify(event)}; expected one of ${EVENTS.join(", ")}`,
      );
    }
  }
  const promptUrgency = config.promptUrgency ?? "critical";
  if (!["low", "normal", "critical"].includes(promptUrgency)) {
    throw new Error(
      `notify: promptUrgency must be low|normal|critical, got ${JSON.stringify(promptUrgency)}`,
    );
  }
  const minTurnMs = config.minTurnMs ?? 0;
  if (!Number.isInteger(minTurnMs) || minTurnMs < 0) {
    throw new Error(
      `notify: minTurnMs must be a non-negative integer, got ${JSON.stringify(minTurnMs)}`,
    );
  }
  return { events, appName: config.appName ?? "dsh", promptUrgency, minTurnMs };
}

function label(agent: Agent | undefined): string {
  if (agent === undefined) return "session";
  const cwd = agent.session.header.cwd;
  if (cwd !== undefined && cwd !== "")
    return cwd.split("/").filter(Boolean).at(-1) ?? cwd;
  return String(agent.session.id).slice(0, 8);
}

function clamp(text: string, max = 200): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function appleString(text: string): string {
  // AppleScript string literal: escape backslash and double quote.
  return `"${text.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`;
}

export function apply(ctx: Context, config: Config = {}): void {
  const opts = resolve(config);
  const enabled = new Set<NotifyEvent>(opts.events);

  const send = (
    summary: string,
    body: string,
    urgency: "low" | "normal" | "critical" = "normal",
  ): void => {
    if (process.platform === "win32") return; // not supported on Windows yet
    if (process.platform === "darwin") {
      // display notification has no urgency; only title and body are used.
      const script = `display notification ${appleString(body)} with title ${appleString(summary)}`;
      execFile("osascript", ["-e", script], (error) => {
        if (error)
          ctx.logger.warn(`notify: osascript failed: ${error.message}`);
      });
      return;
    }
    execFile(
      "notify-send",
      ["--app-name", opts.appName, "--urgency", urgency, "--", summary, body],
      (error) => {
        if (error)
          ctx.logger.warn(`notify: notify-send failed: ${error.message}`);
      },
    );
  };

  const runningSince = new WeakMap<Agent, number>();
  if (enabled.has("idle")) {
    ctx.on(
      "agent/status",
      ({ agent, status }: { agent: Agent; status: "idle" | "running" }) => {
        if (status === "running") {
          runningSince.set(agent, Date.now());
          return;
        }
        const started = runningSince.get(agent);
        runningSince.delete(agent);
        if (started !== undefined && Date.now() - started < opts.minTurnMs)
          return;
        send(`dsh - ${label(agent)}: done`, "Agent is idle.", "normal");
      },
    );
  }

  if (enabled.has("approval")) {
    ctx.on("approval/request", async (request: ApprovalRequest, next) => {
      const reason = request.reason
        ? clamp(request.reason)
        : `Tool ${request.toolName} needs approval.`;
      send(
        `dsh - ${label(request.agent)}: approval needed`,
        reason,
        opts.promptUrgency,
      );
      return next();
    });
  }
  if (enabled.has("question")) {
    ctx.on(
      "user-questions/request",
      async (request: AskUserQuestionRequest, next) => {
        const first = request.questions[0];
        const body = first
          ? clamp(
              first.header
                ? `${first.header}: ${first.question}`
                : first.question,
            )
          : "Agent asked a question.";
        send(
          `dsh - ${label(request.agent)}: question`,
          body,
          opts.promptUrgency,
        );
        return next();
      },
    );
  }

  if (enabled.has("tool-error")) {
    ctx.on(
      "tools/result",
      (
        exec: Readonly<ToolExecution>,
        result: Readonly<ToolExecutionResult>,
      ) => {
        if (!result.isError) return;
        send(
          `dsh - ${label(exec.agent)}: ${exec.name} failed`,
          clamp(result.error.message),
          "normal",
        );
      },
    );
  }

  if (enabled.has("agent-error")) {
    ctx.on(
      "agent/error",
      ({
        agent,
        error,
      }: {
        agent: Agent;
        turn: number;
        step: number;
        error: unknown;
      }) => {
        const message = error instanceof Error ? error.message : String(error);
        send(`${label(agent)}: agent error`, clamp(message), "critical");
      },
    );
  }

  ctx.logger.info(`notify: active for ${[...enabled].join(", ")}`);
}
