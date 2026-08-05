import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const proxyDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const composeFile = path.join(proxyDir, "e2e", "docker-compose.yml");
const project = `tdam-responses-e2e-${Date.now()}`;
const env = { ...process.env, COMPOSE_PROJECT_NAME: project };

function docker(args, options = {}) {
  return spawnSync("docker", args, {
    cwd: proxyDir,
    env,
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
    ...options,
  });
}

function verifyClean() {
  const checks = [
    ["containers", ["ps", "-a", "--filter", `label=com.docker.compose.project=${project}`, "--format", "{{.ID}}"]],
    ["volumes", ["volume", "ls", "--filter", `label=com.docker.compose.project=${project}`, "--format", "{{.Name}}"]],
    ["networks", ["network", "ls", "--filter", `label=com.docker.compose.project=${project}`, "--format", "{{.Name}}"]],
  ];
  const leftovers = [];
  for (const [kind, args] of checks) {
    const result = docker(args, { capture: true });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    if (result.status !== 0) {
      console.error(`Docker cleanup verification failed for ${kind}: ${output}`);
      leftovers.push(kind);
    } else if (result.stdout?.trim()) {
      console.error(`Docker cleanup left ${kind}: ${result.stdout.trim()}`);
      leftovers.push(kind);
    }
  }
  return leftovers.length === 0;
}

let exitCode = 1;
try {
  const result = docker([
    "compose", "-p", project, "-f", composeFile,
    "up", "--build", "--abort-on-container-exit", "--exit-code-from", "runner",
  ]);
  exitCode = result.status ?? 1;
} finally {
  docker(["compose", "-p", project, "-f", composeFile, "down", "-v", "--remove-orphans"]);
  docker(["compose", "-p", project, "-f", composeFile, "ps", "-a"]);
  if (!verifyClean()) exitCode = 1;
}

if (exitCode === 0) {
  console.log(`Real provider smoke: ${process.env.OPENAI_API_KEY ? "NOT_RUN_USE_EXPLICIT_PROVIDER_SMOKE" : "SKIPPED_NO_API_KEY"}`);
  console.log("Repository Responses API validation: PASS");
}
process.exitCode = exitCode;
