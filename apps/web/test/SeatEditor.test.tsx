import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api.ts";
import { SeatEditor } from "../src/setup/SeatEditor.tsx";
import { stubFetch } from "./fetchStub.ts";
import { CREW_CONFIG } from "./fixtures.ts";

afterEach(() => vi.unstubAllGlobals());

const CLAUDE = {
  accountId: "claude-main",
  models: [
    { model: "opus", efforts: ["low", "medium", "high"] },
    { model: "sonnet", efforts: ["low", "medium", "high"] },
  ],
};
const CODEX = { accountId: "codex-main", models: [{ model: "gpt-x", efforts: ["low", "high"] }] };
const config = { ...CREW_CONFIG };

function mount(opts: {
  catalog?: unknown;
  accountId?: string;
  onSave?: (seat: unknown) => Promise<void>;
  onCancel?: () => void;
}) {
  stubFetch({ "/api/accounts/models": opts.catalog ?? [CLAUDE, CODEX] });
  const onSave = vi.fn(opts.onSave ?? (async () => {}));
  const onCancel = opts.onCancel ?? vi.fn();
  render(
    <SeatEditor
      taken={["guido-1"]}
      config={config}
      defaultAccount={opts.accountId ?? "claude-main"}
      onSave={onSave}
      onCancel={onCancel}
    />,
  );
  return { onSave, onCancel, form: screen.getByRole("form", { name: "Add seat" }) };
}

async function fill(form: HTMLElement, model: string, effort: string) {
  await waitFor(() => expect(within(form).getByRole("option", { name: model })).toBeTruthy());
  fireEvent.change(within(form).getByLabelText("Call sign"), { target: { value: "inco-9" } });
  fireEvent.change(within(form).getByLabelText("Model"), { target: { value: model } });
  fireEvent.change(within(form).getByLabelText("Effort"), { target: { value: effort } });
  fireEvent.change(within(form).getByLabelText("Area"), { target: { value: "apps/web/**" } });
  fireEvent.click(within(form).getByLabelText("Reviews PRs in a scratch checkout"));
}

describe("SeatEditor", () => {
  it("sets model, effort, area and scratch mode for a Claude account", async () => {
    const { onSave, form } = mount({});
    await fill(form, "sonnet", "high");
    fireEvent.click(within(form).getByRole("button", { name: "Save seat" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({
      id: "inco-9",
      accountId: "claude-main",
      model: "sonnet",
      effort: "high",
      area: ["apps/web/**"],
      mode: "scratch",
    });
  });

  it("does the same on a Codex catalogue", async () => {
    const { onSave, form } = mount({ accountId: "codex-main" });
    await fill(form, "gpt-x", "low");
    fireEvent.click(within(form).getByRole("button", { name: "Save seat" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({
      accountId: "codex-main",
      model: "gpt-x",
      effort: "low",
      area: ["apps/web/**"],
      mode: "scratch",
    });
  });

  it("groups account and model, and work area, with the area hint after its label", async () => {
    const { form } = mount({});
    const groups = [...form.querySelectorAll("fieldset > legend")].map((l) => l.textContent);
    expect(groups).toEqual(["Seat", "Account and model", "Work area"]);
    const area = within(form).getByLabelText("Area");
    expect(
      document.getElementById(area.getAttribute("aria-describedby") ?? "")?.textContent,
    ).toMatch(/whole checkout/);
  });

  it("explains an invalid attempt, links to the field, and sends nothing", async () => {
    const { onSave, form } = mount({});
    await waitFor(() => expect(within(form).getByRole("option", { name: "opus" })).toBeTruthy());
    const sign = within(form).getByLabelText("Call sign");
    fireEvent.change(sign, { target: { value: "Bad Name" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save seat" }));
    const summary = within(form).getByRole("region", { name: "Fix before saving" });
    expect(sign.getAttribute("aria-invalid")).toBe("true");
    fireEvent.click(within(summary).getByRole("link", { name: /Call sign/ }));
    expect(document.activeElement).toBe(sign);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("keeps the entries after a refusal and shows it in the form", async () => {
    const { form } = mount({
      onSave: async () => {
        throw new ApiError(400, "area overlaps guido-1");
      },
    });
    await fill(form, "sonnet", "high");
    fireEvent.click(within(form).getByRole("button", { name: "Save seat" }));
    const refused = await within(form).findByRole("region", { name: "Not saved" });
    expect(refused.textContent).toContain("area overlaps guido-1");
    expect(within(form).getByLabelText("Call sign")).toHaveProperty("value", "inco-9");
    expect(within(form).getByLabelText("Area")).toHaveProperty("value", "apps/web/**");
  });

  it("saves once for a double submit and holds Cancel while saving", async () => {
    let release: () => void = () => {};
    const { onSave, form } = mount({
      onSave: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    });
    await fill(form, "sonnet", "high");
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(
      (within(form).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    release();
  });
});
