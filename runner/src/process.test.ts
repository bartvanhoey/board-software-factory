import { describe, expect, it } from "vitest";
import { childEnv, runProcess, runShellCommand } from "./process.js";

describe("childEnv", () => {
  it("drops RUNNER_API_TOKEN and keeps the rest", () => {
    const env = childEnv({ EXTRA: "1" }, { PATH: "/bin", ANTHROPIC_API_KEY: "key", RUNNER_API_TOKEN: "secret" });
    expect(env).toEqual({ PATH: "/bin", ANTHROPIC_API_KEY: "key", EXTRA: "1" });
  });

  it("keeps the GitHub token out unless the caller asks for it", () => {
    const base = { PATH: "/bin", GH_TOKEN: "gh", GH_ENTERPRISE_TOKEN: "ghe", GH_PROMPT_DISABLED: "1" };
    expect(childEnv(undefined, base)).toEqual({ PATH: "/bin", GH_PROMPT_DISABLED: "1" });
    expect(childEnv(undefined, base, { githubToken: true })).toEqual(base);
  });

  it("does not let a caller put it back by accident", () => {
    expect(childEnv(undefined, { RUNNER_API_TOKEN: "secret" })).toEqual({});
  });

  it("drops the web service's secrets and anything else not on the allowlist", () => {
    const env = childEnv(undefined, {
      PATH: "/bin",
      HOME: "/home/factory",
      GH_TOKEN: "gh",
      GH_ENTERPRISE_TOKEN: "ghe",
      CLAUDE_CODE_OAUTH_TOKEN: "claude",
      ANTHROPIC_API_KEY: "anthropic",
      DOTNET_NOLOGO: "1",
      MFA_ENCRYPTION_KEY: "web-secret",
      SMTP_PASSWORD: "web-secret",
      ADMIN_PASSWORD: "web-secret",
      BOARD_GITHUB_TOKEN: "web-secret",
      CREATE_ISSUE_GITHUB_TOKEN: "web-secret",
      RUNNER_GITHUB_TOKEN: "runner-secret",
      SOMETHING_ELSE: "x",
    });
    expect(env).toEqual({
      PATH: "/bin",
      HOME: "/home/factory",
      CLAUDE_CODE_OAUTH_TOKEN: "claude",
      ANTHROPIC_API_KEY: "anthropic",
      DOTNET_NOLOGO: "1",
    });
  });

  it("matches names case-insensitively (Path on Windows)", () => {
    expect(childEnv(undefined, { Path: "C:\\bin", Secret: "x" })).toEqual({ Path: "C:\\bin" });
  });
});

describe("what a lane starts", () => {
  const keys = ["RUNNER_API_TOKEN", "MFA_ENCRYPTION_KEY", "SMTP_PASSWORD", "CREATE_ISSUE_GITHUB_TOKEN"];
  const script = `process.stdout.write(String(${JSON.stringify(keys)}.every((k) => process.env[k] === undefined)))`;

  it("does not see the runner API token or the web secrets, as a program or through the shell", async () => {
    for (const k of keys) process.env[k] = "secret-value";
    try {
      expect((await runProcess(process.execPath, ["-e", script])).stdout).toBe("true");
      expect((await runShellCommand(`"${process.execPath}" -e "${script.replace(/"/g, '\\"')}"`)).stdout).toBe("true");
    } finally {
      for (const k of keys) delete process.env[k];
    }
  });

  it("hands the GitHub token only to a program that is started with githubToken", async () => {
    const show = "process.stdout.write(String(process.env.GH_TOKEN))"; // no inner quotes: it also goes through a shell
    process.env.GH_TOKEN = "runner-github-token";
    try {
      expect((await runProcess(process.execPath, ["-e", show])).stdout).toBe("undefined");
      expect((await runShellCommand(`"${process.execPath}" -e "${show}"`)).stdout).toBe("undefined");
      expect((await runProcess(process.execPath, ["-e", show], { githubToken: true })).stdout).toBe("runner-github-token");
    } finally {
      delete process.env.GH_TOKEN;
    }
  });
});
