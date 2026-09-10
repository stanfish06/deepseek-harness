import type { Context } from "@deepseek-ai/cordis";

export const name = "greeting";

function boxed(lines: string[]): string {
  const width = Math.max(...lines.map((line) => line.length));
  const pad = 1;
  const inner = width + pad * 2;
  const horizontal = "═".repeat(inner);
  const top = `╔${horizontal}╗`;
  const bottom = `╚${horizontal}╝`;
  const row = (line: string) => {
    const left = pad + Math.floor((width - line.length) / 2);
    const right = inner - left - line.length;
    return `║${" ".repeat(left)}${line}${" ".repeat(right)}║`;
  };
  const border = `║${" ".repeat(inner)}║`;
  return [top, border, ...lines.map(row), border, bottom].join("\n");
}

export function apply(ctx: Context) {
  console.log(boxed(["<*\\\\><>", "deepseek harness", "Hello Stan!"]));
}
