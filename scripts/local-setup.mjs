import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const projectDirectory = process.cwd();
const cliVersion = "2.117.0";
const browserEnvPath = join(projectDirectory, ".env.local");
const functionsEnvPath = join(projectDirectory, ".env.functions.local");
const tempDirectory = join(projectDirectory, "supabase", ".temp");

function runCli(args, options = {}) {
  const command = process.platform === "win32" ? "cmd.exe" : "npx";
  const commandArgs = process.platform === "win32"
    ? ["/d", "/s", "/c", `npx.cmd --yes supabase@${cliVersion} ${args.join(" ")}`]
    : ["--yes", `supabase@${cliVersion}`, ...args];
  try {
    return execFileSync(command, commandArgs, {
      cwd: projectDirectory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", options.captureStderr ? "pipe" : "ignore"],
    });
  } catch (error) {
    if (options.captureStderr) {
      const details = [error?.stderr, error?.stdout, error?.message]
        .filter((value) => value !== undefined && value !== null)
        .map((value) => String(value).trim())
        .filter(Boolean)
        .join("\n");
      throw new Error(details || "Supabase CLI command failed.");
    }
    throw error;
  }
}

function runtimeStatus() {
  const raw = runCli(["status", "-o", "json"]);
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("Supabase status did not return JSON.");
  return JSON.parse(raw.slice(start, end + 1));
}

function statusValue(status, wanted) {
  const normalized = wanted.replace(/[^a-z]/gi, "").toLowerCase();
  for (const [key, value] of Object.entries(status)) {
    if (typeof value !== "string") continue;
    if (key.replace(/[^a-z]/gi, "").toLowerCase() === normalized) return value;
  }
  throw new Error("Supabase status did not include " + wanted + ".");
}

function readText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

function envValue(text, key) {
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(new RegExp("^" + key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "=(.*)$"));
    if (!match) continue;
    const value = match[1].trim();
    if (value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1).replace(/\\"/g, '"');
    if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
    return value;
  }
  return "";
}

function envLiteral(value) {
  return /^[A-Za-z0-9_./:-]+$/.test(value) ? value : JSON.stringify(value);
}

function updateEnv(text, updates) {
  const keys = new Set(Object.keys(updates));
  const lines = text ? text.split(/\r?\n/) : [];
  const seen = new Set();
  const output = lines.map((line) => {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (!match || !keys.has(match[1])) return line;
    seen.add(match[1]);
    return `${match[1]}=${envLiteral(updates[match[1]])}`;
  });
  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key)) output.push(`${key}=${envLiteral(value)}`);
  }
  return output.filter((line, index, all) => !(index === all.length - 1 && line === "")).join("\n") + "\n";
}

function sqlLiteral(value) {
  return "'" + value.replaceAll("'", "''") + "'";
}

function configureVault(cronSecret) {
  mkdirSync(tempDirectory, { recursive: true });
  const sqlPath = join(tempDirectory, `docchat-vault-${process.pid}.sql`);
  const sql = `do $$
declare
  v_id uuid;
begin
  select id into v_id from vault.secrets where name = 'docchat-cron-secret';
  if v_id is null then
    perform vault.create_secret(${sqlLiteral(cronSecret)}, 'docchat-cron-secret', 'DocChat storage cleanup secret', null::uuid);
  else
    perform vault.update_secret(v_id, ${sqlLiteral(cronSecret)}, 'docchat-cron-secret', 'DocChat storage cleanup secret', null::uuid);
  end if;
end
$$;\n`;
  writeFileSync(sqlPath, sql, "utf8");
  try {
    // The project path is the CLI working directory; use a relative path so
    // cmd.exe does not pass quote characters through to the legacy parser.
    const fileArgument = sqlPath.slice(projectDirectory.length + 1).replaceAll("\\", "/");
    runCli(["db", "query", "--local", "--file", fileArgument], { captureStderr: true });
  } finally {
    try { unlinkSync(sqlPath); } catch { /* best-effort removal of ignored temp SQL */ }
  }
}

function main() {
  const status = runtimeStatus();
  const apiUrl = statusValue(status, "API_URL");
  const anonKey = statusValue(status, "ANON_KEY");
  const functionsText = readText(functionsEnvPath);
  const existingSecret = envValue(functionsText, "CRON_SECRET");
  const cronSecret = existingSecret.length >= 32 ? existingSecret : randomBytes(32).toString("base64url");

  writeFileSync(browserEnvPath, updateEnv(readText(browserEnvPath), {
    NEXT_PUBLIC_SUPABASE_URL: apiUrl,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: anonKey,
  }), "utf8");
  writeFileSync(functionsEnvPath, updateEnv(functionsText, { CRON_SECRET: cronSecret }), "utf8");
  configureVault(cronSecret);

  console.log("Local DocChat setup complete.");
  console.log("Updated browser env and the ignored Edge Function env; no service key was written to browser env.");
  console.log("Serve functions with: npx supabase@2.117.0 functions serve --env-file .env.functions.local");
}

try {
  main();
} catch (error) {
  console.error("Local DocChat setup failed:", error instanceof Error ? error.message : "unknown error");
  process.exitCode = 1;
}
