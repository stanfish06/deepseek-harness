/**
 * Deny shell commands that bypass uv
 */

import type { Context } from "@deepseek-ai/cordis";
import type { PreToolDecision, ToolExecution } from "@deepseek-ai/dsh-tools";

export const name = "uv";

const RULES = [
  "pip",
  "poetry",
  "python-m-pip",
  "python-m-venv",
  "python-m-py_compile",
] as const;
type Rule = (typeof RULES)[number];

export interface Config {
  tools?: string[];
  rules?: Rule[];
}

function resolve(config: Config): Required<Config> {
  const tools = config.tools ?? ["bash"];
  if (tools.length === 0)
    throw new Error("uv: tools must name at least one tool");
  const rules = config.rules ?? [...RULES];
  for (const rule of rules) {
    if (!RULES.includes(rule)) {
      throw new Error(
        `uv: unknown rule ${JSON.stringify(rule)}; expected one of ${RULES.join(", ")}`,
      );
    }
  }
  return { tools, rules };
}

const SEGMENT = String.raw`(?:^|\n|[;|&]{1,2})\s*(?:\S+\/)?`;
const PYTHON = String.raw`python(?:3(?:\.\d+)?)?\b[^\n;|&]*`;
const PATTERNS: Record<Rule, RegExp> = {
  pip: new RegExp(`${SEGMENT}pip3?(?:$|\\s)`, "m"),
  poetry: new RegExp(`${SEGMENT}poetry(?:$|\\s)`, "m"),
  "python-m-pip": new RegExp(`${SEGMENT}${PYTHON}\\s-m\\s*pip\\b`, "m"),
  "python-m-venv": new RegExp(`${SEGMENT}${PYTHON}\\s-m\\s*venv\\b`, "m"),
  "python-m-py_compile": new RegExp(
    `${SEGMENT}${PYTHON}\\s-m\\s*py_compile\\b`,
    "m",
  ),
};

const MESSAGES: Record<Rule, string> = {
  pip: [
    "pip is disabled. Use uv instead:",
    "  To install a package for a script: uv run --with PACKAGE python script.py",
    "  To add a dependency to the project: uv add PACKAGE",
  ].join("\n"),
  poetry: [
    "poetry is disabled. Use uv instead:",
    "  To initialize a project: uv init",
    "  To add a dependency: uv add PACKAGE",
    "  To sync dependencies: uv sync",
    "  To run commands: uv run COMMAND",
  ].join("\n"),
  "python-m-pip": [
    "'python -m pip' is disabled. Use uv instead:",
    "  To install a package for a script: uv run --with PACKAGE python script.py",
    "  To add a dependency to the project: uv add PACKAGE",
  ].join("\n"),
  "python-m-venv": [
    "'python -m venv' is disabled. Use uv instead:",
    "  To create a virtual environment: uv venv",
  ].join("\n"),
  "python-m-py_compile": [
    "'python -m py_compile' is disabled because it writes .pyc files to __pycache__.",
    "  To verify syntax without bytecode output: uv run python -m ast path/to/file.py >/dev/null",
  ].join("\n"),
};

/**
 * Return the denial message for the first enabled rule the command violates.
 * @param command - the shell command text as the model supplied it.
 * @param rules - rules to check, in priority order.
 * @returns the message, or undefined when the command is allowed.
 */
export function blockedReason(
  command: string,
  rules: readonly Rule[] = RULES,
): string | undefined {
  for (const rule of rules) {
    if (PATTERNS[rule].test(command)) return MESSAGES[rule];
  }
  return undefined;
}

export function apply(ctx: Context, config: Config = {}): void {
  const opts = resolve(config);
  const tools = new Set(opts.tools);

  ctx.on(
    "tools/pre-execute",
    async (
      exec: ToolExecution,
      next: () => Promise<PreToolDecision>,
    ): Promise<PreToolDecision> => {
      if (!tools.has(exec.name)) return next();
      const args = exec.arguments;
      if (typeof args !== "object" || args === null) return next();
      const command = (args as { command?: unknown }).command;
      if (typeof command !== "string") return next();
      const reason = blockedReason(command, opts.rules);
      if (reason === undefined) return next();
      ctx.logger.info(`uv: denied ${exec.name}: ${command.split("\n")[0]}`);
      return { kind: "deny", reason };
    },
  );

  ctx.logger.info(
    `uv: watching ${[...tools].join(", ")} for ${opts.rules.join(", ")}`,
  );
}
