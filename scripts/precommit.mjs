import { spawnSync } from "node:child_process";

function run(command, args, options = {}) {
  console.log(`$ ${[command, ...args].join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: "inherit",
    env: process.env,
    timeout: options.timeoutMs ?? 300000,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with status ${result.status}`);
  }
}

function cmuxAvailable() {
  const result = spawnSync("cmux", ["--json", "identify"], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 15000,
  });
  return { ok: result.status === 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status };
}

async function main() {
  run("bun", ["test", "./tests/cmux-browser-tools.test.ts"], { timeoutMs: 120000 });

  const check = cmuxAvailable();
  if (!check.ok) {
    if (process.env.CMUX_PRECOMMIT_SKIP_INTERACTIVE === "1") {
      console.warn("CMUX_PRECOMMIT_SKIP_INTERACTIVE=1 set; skipping required interactive cmux smoke for emergency commit only.");
    } else {
      throw new Error([
        "Interactive cmux coverage is required for this repo precommit.",
        "Start or attach to a cmux workspace so `cmux --json identify` succeeds, then rerun `bun run precommit`.",
        "Emergency-only bypass: CMUX_PRECOMMIT_SKIP_INTERACTIVE=1 bun run precommit.",
        `cmux status ${check.status}: ${check.stderr || check.stdout || "no output"}`,
      ].join("\n"));
    }
  } else if (process.env.CMUX_PRECOMMIT_SKIP_INTERACTIVE === "1") {
    console.warn("CMUX_PRECOMMIT_SKIP_INTERACTIVE=1 set; skipping interactive cmux smoke despite cmux being available.");
  } else {
    run("bun", ["run", "test:interactive"], { timeoutMs: 300000 });
  }

  if (process.env.CMUX_PRECOMMIT_MODEL_EVAL === "1") {
    run("bun", ["run", "eval:cmux-browsergym"], { timeoutMs: 300000 });
  } else {
    console.log("Skipping provider-backed OMP eval; set CMUX_PRECOMMIT_MODEL_EVAL=1 to run it explicitly.");
  }
}

await main();
