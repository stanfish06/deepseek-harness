/**
 * Custom launcher
 */

import type { ChildProcess } from "node:child_process";
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DSH_BIN = join(REPO_ROOT, "apps/cli/src/bin.ts");
const URL_LINE = /dsh web: (http:\/\/\S+)/u;
const CHROMIUM_LIKE = /chrom|brave|edge|vivaldi|opera/iu;
// macOS browsers that accept the --app= PWA flag. User's usual rotation
// (chrome, brave, helium) is probed first, then other Chromium apps.
const MAC_BROWSER_APPS = [
  "Google Chrome.app",
  "Brave Browser.app",
  "Helium.app",
  "Microsoft Edge.app",
  "Vivaldi.app",
  "Opera.app",
  "Arc.app",
];

type OpenMode = "app" | "tab" | "none";

function openMode(): OpenMode {
  const raw = process.env.DSH_DEV_OPEN ?? "app";
  if (raw === "app" || raw === "tab" || raw === "none") return raw;
  throw new Error(
    `DSH_DEV_OPEN must be app, tab, or none; got ${JSON.stringify(raw)}`,
  );
}

async function xdgDefaultBrowser(): Promise<string[] | undefined> {
  if (process.platform !== "linux") return undefined;
  let desktopId: string;
  try {
    const { stdout } = await promisify(execFile)("xdg-settings", [
      "get",
      "default-web-browser",
    ]);
    desktopId = stdout.trim();
  } catch {
    return undefined;
  }
  if (desktopId === "") return undefined;
  const dataDirs = [
    process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share"),
    ...(process.env.XDG_DATA_DIRS ?? "/usr/local/share:/usr/share").split(":"),
  ];
  const file = dataDirs
    .map((dir) => join(dir, "applications", desktopId))
    .find((path) => existsSync(path));
  if (file === undefined) return undefined;
  const entry =
    readFileSync(file, "utf8").split(/^\[(?!Desktop Entry\])/mu)[0] ?? "";
  const exec = /^Exec=(.+)$/mu.exec(entry)?.[1];
  if (exec === undefined) return undefined;
  const argv = exec
    .trim()
    .split(/\s+/u)
    .filter((arg) => !/^%[a-zA-Z]$/u.test(arg));
  return argv.length > 0 ? argv : undefined;
}

// macOS app mode launches a Chromium-family app as a PWA via `open -na`.
// Returns the base `open` argv; openBrowser appends `--app=<url>`.
function macAppModeArgv(): { argv: string[]; asApp: boolean } | undefined {
  if (process.platform !== "darwin") return undefined;
  for (const app of MAC_BROWSER_APPS) {
    // `open -a` takes the app name (with or without .app) or a path.
    if (existsSync(join("/Applications", app)) === false) continue;
    return { argv: ["open", "-n", "-a", app, "--args"], asApp: true };
  }
  return undefined;
}

async function browserArgv(
  mode: Exclude<OpenMode, "none">,
): Promise<{ argv: string[]; asApp: boolean }> {
  const override = process.env.DSH_DEV_BROWSER;
  if (override !== undefined && override !== "") {
    const base = override.split(/\s+/u);
    const asApp =
      mode === "app" && CHROMIUM_LIKE.test(basename(base[0] ?? ""));
    return { argv: base, asApp };
  }
  if (mode === "app") {
    const macApp = macAppModeArgv();
    if (macApp !== undefined) return macApp;
  }
  const base = await xdgDefaultBrowser();
  if (base !== undefined) {
    const asApp =
      mode === "app" && CHROMIUM_LIKE.test(basename(base[0] ?? ""));
    return { argv: base, asApp };
  }
  const opener =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  return { argv: [opener], asApp: false };
}

async function openBrowser(
  url: string,
  mode: Exclude<OpenMode, "none">,
): Promise<void> {
  const { argv, asApp } = await browserArgv(mode);
  const [command, ...flags] = argv;
  if (command === undefined) return;
  const args = asApp ? [...flags, `--app=${url}`] : [...flags, url];
  if (mode === "app" && !asApp) {
    process.stderr.write(
      `launch-web: ${basename(command)} has no --app mode; opening a tab\n`,
    );
  }
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    shell: command === "start",
  });
  child.once("error", (error) => {
    process.stderr.write(
      `launch-web: could not start ${command}: ${error.message}\n`,
    );
  });
  child.unref();
}

function forwardSignals(child: ChildProcess): void {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      child.kill(signal);
    });
  }
}

function main(): void {
  const mode = openMode();
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx/esm",
      DSH_BIN,
      "web",
      ...process.argv.slice(2),
      "--no-open",
    ],
    {
      cwd: REPO_ROOT,
      stdio: ["inherit", "pipe", "pipe"],
    },
  );
  forwardSignals(child);

  let buffered = "";
  let opened = false;
  const watch = (chunk: Buffer, sink: NodeJS.WriteStream): void => {
    sink.write(chunk);
    if (opened) return;
    buffered = `${buffered}${chunk.toString()}`.slice(-16_384);
    const url = URL_LINE.exec(buffered)?.[1];
    if (url === undefined) return;
    opened = true;
    if (mode === "none") return;
    void openBrowser(url, mode);
  };
  child.stdout.on("data", (chunk: Buffer) => {
    watch(chunk, process.stdout);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    watch(chunk, process.stderr);
  });
  child.once("error", (error) => {
    process.stderr.write(`launch-web: could not start dsh: ${error.message}\n`);
    process.exit(1);
  });
  child.once("exit", (code, signal) => {
    process.exit(
      code ?? (signal === null ? 1 : 128 + (signal === "SIGINT" ? 2 : 15)),
    );
  });
}

main();
