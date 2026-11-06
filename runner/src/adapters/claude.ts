import type { AgentRunner, Shell } from "../ports.js";
import { runProcess, runShellCommand } from "../process.js";

/** The coding agent: `claude -p`, prompt on stdin, authenticated through ANTHROPIC_API_KEY. */
export const claudeAgent: AgentRunner = {
  async run({ cwd, prompt, maxTurns, allowedTools, disallowedTools, logFile, env }) {
    const result = await runProcess(
      "claude",
      ["-p", "--max-turns", String(maxTurns), "--allowedTools", ...allowedTools, "--disallowedTools", ...disallowedTools],
      { cwd, input: prompt, logFile, env, agentCredential: true },
    );
    if (result.code !== 0) throw new Error(`claude exited with code ${result.code}`);
    return result.stdout;
  },
};

/** Project commands come from the committed, read-only registry, so a shell is acceptable here. */
export const shellRunner: Shell = {
  async run(command, { cwd, logFile }) {
    const result = await runShellCommand(command, { cwd, logFile });
    return { ok: result.code === 0 };
  },
};
