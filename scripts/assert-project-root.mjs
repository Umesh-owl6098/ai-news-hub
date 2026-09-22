#!/usr/bin/env node
// Fail-fast guard against launching this project's dev/build tooling from
// the wrong directory or against the wrong package.json. Exists because a
// browser-preview/debug tool's OWN session-level working-directory tracking
// can drift to a PARENT workspace folder (e.g. `~/Desktop`) that hosts a
// completely unrelated sibling project (in this codebase's case, a project
// named "jarvis") with its own `.claude/launch.json`. When that happens,
// `npm run dev` for THIS project is never what actually gets invoked — the
// other project's own dev command runs instead, entirely outside this
// script's reach. This guard cannot fix that class of failure (see
// README.md's Development section); its job is narrower and unconditional:
// if *this* project's own `dev` script is ever invoked with a working
// directory or package.json that isn't really this repo, refuse to
// silently continue.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { execFileSync } from "node:child_process";

const EXPECTED_PACKAGE_NAME = "ai-news-hub";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

function fail(message) {
  console.error(`\n[assert-project-root] ${message}\n`);
  process.exit(1);
}

let pkg;
try {
  pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf-8"));
} catch (error) {
  fail(`Could not read package.json next to this script at ${repoRoot}: ${error.message}`);
}

if (pkg.name !== EXPECTED_PACKAGE_NAME) {
  fail(
    `package.json at ${repoRoot} is named "${pkg.name}", not "${EXPECTED_PACKAGE_NAME}". ` +
      `This script only belongs to the ${EXPECTED_PACKAGE_NAME} project — refusing to start.`
  );
}

const cwd = process.cwd();
if (path.resolve(cwd) !== path.resolve(repoRoot)) {
  fail(
    `Working directory is ${cwd}, but this project's root is ${repoRoot}. ` +
      `Run npm commands from inside ${EXPECTED_PACKAGE_NAME} itself, not from a parent folder.`
  );
}

// Best-effort: if git is available and this happens to be a git checkout,
// cross-check its toplevel too. Never fails the guard on its own — a
// missing git binary or a non-git checkout (e.g. some CI archives) isn't
// itself evidence of the wrong project.
try {
  const gitToplevel = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  if (gitToplevel && path.resolve(gitToplevel) !== path.resolve(repoRoot)) {
    fail(
      `git's own repository root is ${gitToplevel}, which doesn't match this project's directory ${repoRoot}. ` +
        `This usually means ${EXPECTED_PACKAGE_NAME} is nested inside another git checkout unexpectedly — investigate before starting the dev server.`
    );
  }
} catch {
  // No git binary, or not a git repository at all — not a project-identity signal either way.
}

console.log(`[assert-project-root] OK — ${EXPECTED_PACKAGE_NAME} at ${repoRoot}`);
