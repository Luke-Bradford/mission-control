import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ConfigYaml, scalar } from "../src/components/config/ConfigYaml.tsx";
import { GLOSSARY_ID, Glossary } from "../src/components/config/Glossary.tsx";
import { CONFIG } from "./fixtures.ts";

describe("ConfigYaml", () => {
  it("renders the config as YAML with the file's snake_case keys", () => {
    render(<ConfigYaml config={CONFIG} />);
    const yaml = screen.getByTestId("config-yaml").textContent ?? "";
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
    const count = (yaml.textContent ?? "").split("\n").length;
    expect(container.querySelector(".yaml .yln")?.textContent?.split("\n")).toHaveLength(count);
    expect(screen.getByRole("region", { name: "config.yaml, read-only" })).toBeTruthy();
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
});
