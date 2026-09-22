import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Step 29 — regression guards for the 3 fixes made during the end-to-end
 * product readiness audit. Static-analysis style, mirroring the pattern
 * established in refreshArchitecture.test.ts / homeIaArchitecture.test.ts
 * / readingStateArchitecture.test.ts — this codebase has no React
 * component-rendering test infrastructure, so for UI-behavior fixes these
 * assert against the actual source text (confirming the fix's mechanism is
 * still present) rather than mocking a DOM. Each fix was additionally
 * verified live via real browser reproduction/re-test — see the Step 29
 * final report.
 */
const projectRoot = path.resolve(__dirname, "..", "..");

function readSource(relativePath: string): string {
  return readFileSync(path.join(projectRoot, relativePath), "utf-8");
}

describe("Step 29 fix #1 — every Sidebar nav item has a real destination", () => {
  const DEAD_LABELS = [
    "Latest",
    "Notifications",
    "All Sources",
    "RSS Feeds",
    "Profile",
    "Preferences",
    "Integrations",
    "Data & Privacy",
    "Appearance",
  ];

  it.each(DEAD_LABELS)('Sidebar.tsx no longer defines a nav item for "%s"', (label) => {
    const source = readSource("src/components/Sidebar.tsx");
    // Checks the actual NavItem object-literal usage (`label: "X"`), not
    // a blanket text search — a prose mention explaining the removal (as
    // in this file's own audit doc comment) is fine, an actual nav entry
    // is not.
    expect(source).not.toContain(`label: "${label}"`);
  });

  it("Sidebar.tsx no longer defines a Sources or Settings section", () => {
    const source = readSource("src/components/Sidebar.tsx");
    expect(source).not.toContain("sourceItems");
    expect(source).not.toContain("settingsItems");
    expect(source).not.toMatch(/title="Sources"/);
    expect(source).not.toMatch(/title="Settings"/);
  });

  it("every remaining tab-mapped nav label is wired in DashboardClient's SIDEBAR_LABEL_TO_TAB", () => {
    const sidebarSource = readSource("src/components/Sidebar.tsx");
    const dashboardSource = readSource("src/components/DashboardClient.tsx");

    // The 5 labels in Sidebar.tsx's navItems that have no `href` (i.e.
    // rely on the onNavItemClick tab-mapping) — extracted by the same
    // shape the milestone's audit found broken.
    const tabMappedLabels = ["Home", "Papers (arXiv)", "GitHub Repositories", "Hacker News", "Discussions", "Bookmarks"];
    for (const label of tabMappedLabels) {
      expect(sidebarSource).toContain(`"${label}"`);
      expect(dashboardSource).toContain(`"${label}"`);
    }
    expect(dashboardSource).toContain("SIDEBAR_LABEL_TO_TAB");
    expect(dashboardSource).toContain("TAB_TO_SIDEBAR_LABEL");
  });
});

describe("Step 29 fix #2 — stale toggle state after Back navigation", () => {
  it("next.config.ts sets staleTimes.dynamic to 0", () => {
    const source = readSource("next.config.ts");
    expect(source).toMatch(/staleTimes/);
    expect(source).toMatch(/dynamic:\s*0/);
  });

  it("PopstateRefresh is mounted once in the root layout", () => {
    const layoutSource = readSource("src/app/layout.tsx");
    expect(layoutSource).toContain("PopstateRefresh");

    const componentSource = readSource("src/components/PopstateRefresh.tsx");
    expect(componentSource).toContain("popstate");
    expect(componentSource).toContain("router.refresh()");
  });

  it("useOptimisticToggle re-syncs local state when initialValue changes", () => {
    const source = readSource("src/lib/useOptimisticToggle.ts");
    expect(source).toMatch(/useEffect/);
    expect(source).toMatch(/initialValue/);
    // The re-sync must be conditional on initialValue actually changing
    // (a ref comparison), not an unconditional setValue on every render,
    // which would fight the optimistic update mid-toggle.
    expect(source).toContain("useRef");
  });
});

describe("Step 29 fix #3 — mobile nav drawer accessibility", () => {
  it("the mobile nav drawer has dialog semantics", () => {
    const source = readSource("src/components/DashboardClient.tsx");
    expect(source).toContain('role="dialog"');
    expect(source).toContain('aria-modal="true"');
  });

  it("the mobile nav drawer closes on Escape", () => {
    const source = readSource("src/components/DashboardClient.tsx");
    expect(source).toMatch(/e\.key === "Escape"/);
  });

  it("focus moves into the drawer on open and returns to the trigger on close", () => {
    const source = readSource("src/components/DashboardClient.tsx");
    expect(source).toContain("mobileNavCloseButtonRef");
    expect(source).toContain("mobileNavOpenButtonRef");
    expect(source).toMatch(/mobileNavCloseButtonRef\.current\?\.focus\(\)/);
    expect(source).toMatch(/mobileNavOpenButtonRef\.current\?\.focus\(\)/);
  });

  it("the open trigger exposes aria-expanded", () => {
    const source = readSource("src/components/DashboardClient.tsx");
    expect(source).toMatch(/aria-expanded=\{mobileNavOpen\}/);
  });
});
