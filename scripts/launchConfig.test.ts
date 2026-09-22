import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Regression guard for the incident where a browser-preview tool resolved
 * a PARENT workspace folder's `.claude/launch.json` (belonging to an
 * unrelated sibling project, "jarvis") instead of this repo's own. This
 * test can't fix that class of bug (it's about which directory a tool
 * resolves the file FROM, not the file's content) — it only makes sure
 * this project's own launch.json never regresses into referencing that
 * other project, an unrelated hardcoded port, or a path outside this repo.
 */
const REPO_ROOT = path.resolve(__dirname, "..");
const launchConfigPath = path.join(REPO_ROOT, ".claude", "launch.json");

interface LaunchConfiguration {
  name: string;
  runtimeExecutable?: string;
  runtimeArgs?: string[];
  port?: number;
  url?: string;
}

function loadLaunchConfig(): LaunchConfiguration[] {
  const raw = JSON.parse(readFileSync(launchConfigPath, "utf-8"));
  return raw.configurations ?? [];
}

describe("project-local .claude/launch.json isolation", () => {
  it("contains at least one configuration for this project", () => {
    expect(loadLaunchConfig().length).toBeGreaterThan(0);
  });

  it("never references the unrelated sibling 'jarvis' project by name, command, or args", () => {
    for (const config of loadLaunchConfig()) {
      const haystack = JSON.stringify(config).toLowerCase();
      expect(haystack).not.toContain("jarvis");
    }
  });

  it("never hardcodes port 3000, which the sibling jarvis project owns", () => {
    for (const config of loadLaunchConfig()) {
      if (typeof config.port === "number") {
        expect(config.port).not.toBe(3000);
      }
      if (config.url) {
        expect(config.url).not.toContain(":3000");
      }
    }
  });

  it("every configuration's name identifies this project, not a generic/shared one", () => {
    for (const config of loadLaunchConfig()) {
      expect(config.name.toLowerCase()).toContain("ai-news-hub");
    }
  });

  it("this project's own package.json is named ai-news-hub (sanity check the file the guard script protects)", () => {
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf-8"));
    expect(pkg.name).toBe("ai-news-hub");
  });
});
