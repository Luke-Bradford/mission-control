import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ConfigYaml, scalar } from "../src/components/config/ConfigYaml.tsx";
import { GLOSSARY_ID, Glossary } from "../src/components/config/Glossary.tsx";
import { CONFIG } from "./fixtures.ts";

/** The YAML a view shows: each row's text cell, one per line (the numbers are not part of it). */
const yamlOf = (root: HTMLElement) =>
  [...root.querySelectorAll(".ytx")].map((c) => c.textContent).join("\n");

describe("ConfigYaml", () => {
  it("renders the config as YAML with the file's snake_case keys", () => {
    render(<ConfigYaml config={CONFIG} />);
    const yaml = yamlOf(screen.getByTestId("config-yaml"));
    for (const line of [
      "operator:\n  id: operator\n  timezone: Europe/London",
      "  - id: claude-main\n    vendor: claude\n    alert_at: 85",
      "    stop_at: 80",
      "    github: octo-org/shop-app\n    project: 2",
      "    status_map:",
      "      In Progress: in progress",
      "    needs_you_labels: [needs-design]",
      "    repo_id: shop-app\n    kind: ta-loop\n    account_id: claude-main",
      "    state_dir: /u/.shop-app-autonomy/var/autonomy",
      "    launchd_label: com.shop-app.ta-loop",
      "poll:\n  usage_minutes: 30",
      "  github_seconds: 60",
    ]) {
      expect(yaml).toContain(line);
    }
    expect(yaml).not.toMatch(/alertAt|statusMap|stateDir|launchdLabel|usageMinutes/);
    expect(yaml).not.toContain("logs_dir"); // null in the view: not in the file either
    expect(yaml.split("\n")[0]).toMatch(/^# ~\/\.config\/mission-control\/config\.yaml.*read-only/);
  });

  it("colours keys, values and comments and numbers every line", () => {
    const { container } = render(<ConfigYaml config={CONFIG} />);
    const yaml = screen.getByTestId("config-yaml");
    expect(container.querySelector(".yk")?.textContent).toBe("operator:");
    expect(container.querySelector(".yv")?.textContent).toBe("operator");
    expect(container.querySelector(".yc")?.textContent).toMatch(/^# /);
    const count = yamlOf(yaml).split("\n").length;
    expect(container.querySelectorAll(".yaml .yln")).toHaveLength(count);
    expect(screen.getByRole("region", { name: "config.yaml, read-only" })).toBeTruthy();
  });

  it("keeps one line number beside its own line when a line is far longer than the view", () => {
    const long = `/Users/someone/${"deeply/nested/".repeat(40)}worktree`;
    const config = {
      ...CONFIG,
      loops: CONFIG.loops.map((l, i) => (i === 0 ? { ...l, worktree: long } : l)),
    };
    const { container } = render(<ConfigYaml config={config} />);
    const rows = [...container.querySelectorAll(".yaml .yrow")];
    expect(rows.length).toBeGreaterThan(5);
    rows.forEach((row, i) => {
      expect(row.querySelectorAll(".yln")).toHaveLength(1);
      expect(row.querySelectorAll(".ytx")).toHaveLength(1);
      expect(row.querySelector(".yln")?.textContent).toBe(String(i + 1));
      expect(row.querySelector(".yln")?.getAttribute("aria-hidden")).toBe("true");
      expect(row.querySelector(".ytx")?.textContent).not.toContain("\n");
    });
    expect(rows.some((r) => r.querySelector(".ytx")?.textContent?.includes(long))).toBe(true);
  });

  it("never shows a password or its hash", () => {
    render(<ConfigYaml config={CONFIG} />);
    expect(document.body.textContent?.toLowerCase()).not.toContain("password");
  });
});

describe("scalar", () => {
  it("quotes strings YAML would read differently", () => {
    expect(scalar("Europe/London")).toBe("Europe/London");
    expect(scalar("In Progress")).toBe("In Progress");
    expect(scalar("yes")).toBe('"yes"');
    expect(scalar("2")).toBe('"2"');
    expect(scalar("a: b")).toBe('"a: b"');
    expect(scalar("x # y")).toBe('"x # y"');
    expect(scalar("")).toBe('""');
  });

  it("carries no plan marks, and notes stop_at and alert_at as they are", () => {
    render(<ConfigYaml config={CONFIG} />);
    const yaml = yamlOf(screen.getByTestId("config-yaml"));
    expect(yaml).not.toMatch(/Plan [234]/);
    expect(yaml).toContain("% of a window: no new runs; forecast shown now");
    expect(yaml).toContain("% of a window: notify you (notifications are not built yet)");
  });
});

describe("Glossary", () => {
  it("is a panel with its anchor and the data-model terms", () => {
    const { container } = render(<Glossary />);
    const gloss = container.querySelector("dl.gloss");
    expect(gloss).not.toBeNull();
    expect(container.querySelector(`#${GLOSSARY_ID}`)).not.toBeNull();
    expect(screen.getByRole("region", { name: "Glossary and data model" })).toBeTruthy();
    expect(gloss?.textContent).toContain("API-equivalent");
    expect(gloss?.textContent).toContain("ta-loop (a scheduled task loop)");
    expect(gloss?.textContent).toContain("studio-loop (a build-driver loop)");
  });

  it("carries no plan marks and describes the crew and the states as they are", () => {
    const { container } = render(<Glossary />);
    const text = container.querySelector("dl.gloss")?.textContent ?? "";
    expect(text).not.toMatch(/Plan [234]/);
    expect(text).not.toContain("later plans");
    expect(text).toContain(
      "Crew seats come from the crew section of config.yaml, each with a role.",
    );
    expect(text).toContain(
      "Each crew seat is one agent that Mission Control runs. Each adopted loop is one agent too:",
    );
    expect(text).toContain(
      "The state pill reads Running · Stalled · Blocked · Parked · Waiting · Idle · Stopped · Error. Stalled = no output for 10 minutes (60 while a background task runs). paused = a ta-loop's PAUSE file exists.",
    );
    expect(text).toContain(
      "no new runs start on the account there. alert_at notifications are not built yet.",
    );
  });
});
