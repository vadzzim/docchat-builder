import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const projectDirectory = process.cwd();
const denoVersion = process.env.DENO_VERSION ?? "2.9.6";
const supabaseVersion = process.env.SUPABASE_CLI_VERSION ?? "2.117.0";

function command(name, args) {
  const windows = process.platform === "win32";
  const executable = windows ? "cmd.exe" : name;
  const commandArgs = windows
    ? ["/d", "/s", "/c", `${name === "npx" || name === "pnpm" ? name + ".cmd" : name} ${args.join(" ")}`]
    : args;
  try {
    return execFileSync(executable, commandArgs, {
      cwd: projectDirectory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unavailable";
  }
}

function firstLine(value) {
  return value.split(/\r?\n/, 1)[0] || "unavailable";
}

function git(args) {
  return command("git", args);
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const packageJson = JSON.parse(readFileSync(join(projectDirectory, "package.json"), "utf8"));
const lockfiles = {};
for (const fileName of ["pnpm-lock.yaml", "deno.lock"]) {
  const path = join(projectDirectory, fileName);
  if (existsSync(path)) lockfiles[fileName] = sha256(path);
}
const outputPath = process.env.DOCCHAT_RUNTIME_MANIFEST ?? join(projectDirectory, "test-results", "runtime-manifest.json");
mkdirSync(dirname(outputPath), { recursive: true });
const manifest = {
  generatedAt: new Date().toISOString(),
  commit: {
    sha: process.env.GITHUB_SHA ?? git(["rev-parse", "HEAD"]),
    dirty: Boolean(git(["status", "--porcelain"])),
  },
  runtime: {
    node: process.version,
    pnpm: command("pnpm", ["--version"]),
    deno: firstLine(command("npx", ["--yes", `deno@${denoVersion}`, "--version"])),
    supabase: firstLine(command("npx", ["--yes", `supabase@${supabaseVersion}`, "--version"])),
    playwright: firstLine(command("pnpm", ["exec", "playwright", "--version"])),
    platform: process.platform,
    arch: process.arch,
  },
  dependencies: {
    packageManager: packageJson.packageManager,
    next: packageJson.dependencies?.next,
    supabaseJs: packageJson.dependencies?.["@supabase/supabase-js"],
    playwright: packageJson.devDependencies?.["@playwright/test"],
  },
  lockfiles,
};
const serialized = JSON.stringify(manifest, null, 2) + "\n";
writeFileSync(outputPath, serialized, "utf8");
console.log("Runtime manifest wrote " + relative(projectDirectory, outputPath));
