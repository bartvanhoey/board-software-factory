import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface ProcessOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** Written to the process's stdin, so long text never goes through argv or a shell. */
  input?: string;
  /** Output is appended here as well as returned. */
  logFile?: string;
  timeoutMs?: number;
  /**
   * Pass the runner's GitHub token (GH_TOKEN) on. Off by default: only the runner's own `gh` calls and git's network
   * commands need it. The agent and the project's build and test commands never do, and they run text and code from
   * issues and repositories.
   */
  githubToken?: boolean;
  /**
   * Pass the agent's credential (CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY) on. Off by default: only the `claude`
   * process needs it. The project's build and test commands run code from the repository and never do.
   */
  agentCredential?: boolean;
}

function appendLog(file: string | undefined, text: string): void {
  if (!file || text.length === 0) return;
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, text);
}

function collect(child: ReturnType<typeof spawn>, label: string, opts: ProcessOptions): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = opts.timeoutMs ? setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs) : undefined;
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
      appendLog(opts.logFile, d.toString());
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
      appendLog(opts.logFile, d.toString());
    });
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      reject(new Error(`failed to start ${label}: ${e.message}`));
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    if (opts.input !== undefined) child.stdin?.end(opts.input);
    else child.stdin?.end();
  });
}

/** Variables a child may inherit (names are compared case-insensitively, as Windows does). */
const INHERITED_NAMES = new Set([
  // process basics
  "PATH", "PATHEXT", "HOME", "USER", "LOGNAME", "SHELL", "TERM", "LANG", "TZ", "CI", "TMPDIR", "TMP", "TEMP",
  "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SYSTEMROOT", "WINDIR", "COMSPEC", "PROGRAMFILES", "PROGRAMDATA",
  // (the agent's credential and the GitHub token are separate, see AGENT_CREDENTIAL_NAME and GITHUB_TOKEN_NAME)
  // tool behaviour set by the image
  "DISABLE_AUTOUPDATER", "NEXT_TELEMETRY_DISABLED",
  // network settings a deployment behind a proxy needs
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR",
]);
const INHERITED_PREFIXES = ["LC_", "DOTNET_", "NUGET_", "NODE_", "NPM_", "GIT_", "GH_", "CLAUDE_CODE_", "ANTHROPIC_"];
/** GH_TOKEN, GH_ENTERPRISE_TOKEN: only passed on when the caller asks for the GitHub token. */
const GITHUB_TOKEN_NAME = /^GH_.*TOKEN$/;
/** The agent's login: only passed on when the caller asks for the agent credential. */
const AGENT_CREDENTIAL_NAME = /^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN)$/;

/**
 * The environment for everything a lane starts (git, gh, the agent, the project's own commands). It is an allowlist:
 * the agent follows instructions found in issues and the project commands are code from the repository, so they get
 * only what they need to run. Anything else in the runner's environment (RUNNER_API_TOKEN, and any secret that ends up
 * there by mistake) is not passed on. The GitHub token is passed only with `githubToken`, the agent's credential only with
 * `agentCredential`. `extra` is added as given.
 */
export function childEnv(
  extra: NodeJS.ProcessEnv | undefined,
  base: NodeJS.ProcessEnv = process.env,
  { githubToken = false, agentCredential = false }: { githubToken?: boolean; agentCredential?: boolean } = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    const key = name.toUpperCase();
    if (GITHUB_TOKEN_NAME.test(key)) {
      if (githubToken) env[name] = value;
    } else if (AGENT_CREDENTIAL_NAME.test(key)) {
      if (agentCredential) env[name] = value;
    } else if (INHERITED_NAMES.has(key) || INHERITED_PREFIXES.some((p) => key.startsWith(p))) env[name] = value;
  }
  return { ...env, ...extra };
}

/** Run a program with an argument array: no shell, so no quoting problems and no injection. */
export function runProcess(file: string, args: readonly string[], opts: ProcessOptions = {}): Promise<ProcessResult> {
  const child = spawn(file, [...args], {
    cwd: opts.cwd,
    env: childEnv(opts.env, process.env, opts),
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
  });
  return collect(child, file, opts);
}

/** Run a trusted command line (from the project registry) through the platform shell. */
export function runShellCommand(command: string, opts: ProcessOptions = {}): Promise<ProcessResult> {
  const child = spawn(command, {
    cwd: opts.cwd,
    env: childEnv(opts.env, process.env, opts),
    stdio: ["pipe", "pipe", "pipe"],
    shell: true,
  });
  return collect(child, command, opts);
}

/** stdout of a process that must succeed; throws with its stderr otherwise. */
export async function mustRun(file: string, args: readonly string[], opts: ProcessOptions = {}): Promise<string> {
  const result = await runProcess(file, args, opts);
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim().split("\n").slice(-3).join(" | ");
    throw new Error(`${file} ${args.slice(0, 2).join(" ")} failed (exit ${result.code}): ${detail}`);
  }
  return result.stdout;
}
