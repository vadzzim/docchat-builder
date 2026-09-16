import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const projectDirectory = process.cwd();
const [, , label, commandName, ...rawArgs] = process.argv;
if (!label || !commandName) {
  console.error("Usage: node scripts/ci-command.mjs <label> <command> [args] [--stdin-file=<path>]");
  process.exit(2);
}

const stdinFlag = rawArgs.find((argument) => argument.startsWith("--stdin-file="));
const args = rawArgs.filter((argument) => argument !== stdinFlag);
const stdin = stdinFlag ? readFileSync(stdinFlag.slice("--stdin-file=".length)) : undefined;
const windowsShellCommand = process.platform === "win32" && ["npx", "pnpm"].includes(commandName);
const executable = windowsShellCommand ? "cmd.exe" : commandName;
const commandArgs = windowsShellCommand
  ? ["/d", "/s", "/c", `${commandName}.cmd ${args.join(" ")}`]
  : args;
const startedAt = Date.now();
const result = spawnSync(executable, commandArgs, {
  cwd: projectDirectory,
  ...(stdin === undefined ? {} : { input: stdin }),
  stdio: stdin === undefined ? ["inherit", "inherit", "inherit"] : ["pipe", "inherit", "inherit"],
});
const record = {
  label,
  status: result.status === 0 ? "passed" : "failed",
  exitCode: result.status,
  signal: result.signal,
  durationMs: Date.now() - startedAt,
  completedAt: new Date().toISOString(),
};
const reportPath = process.env.DOCCHAT_CI_RESULTS ?? join(projectDirectory, "test-results", "ci-command-results.json");
mkdirSync(dirname(reportPath), { recursive: true });
const records = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, "utf8")) : [];
records.push(record);
writeFileSync(reportPath, JSON.stringify(records, null, 2) + "\n", "utf8");
if (result.error) {
  console.error(`${label} failed to start: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
