import { render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MentionText } from "../src/comms/messages.tsx";
import { stubFetch } from "./fetchStub.ts";
import { CONFIG } from "./fixtures.ts";

describe("MentionText", () => {
  it.each(["octocat", null, undefined])(
    "matches whole mentions with login %s",
    async (githubLogin) => {
      stubFetch({ "/api/config": { ...CONFIG, githubLogin } });
      const text = "@CAPCOM (@capcom) @OctoCat @operator @octocat-other @someone";
      const { container } = render(<MentionText text={text} />);
      await waitFor(() =>
        expect([...container.querySelectorAll(".mention")].map((el) => el.textContent)).toEqual(
          githubLogin ? ["@CAPCOM", "@capcom", "@OctoCat"] : ["@CAPCOM", "@capcom"],
        ),
      );
      expect(container.textContent).toBe(text);
    },
  );

  it("does not highlight email addresses or mentions preceded by a word or dot", async () => {
    stubFetch({ "/api/config": { ...CONFIG, githubLogin: "octocat" } });
    const text = "hi@CAPCOM.com hi@octocat.com .@CAPCOM _@CAPCOM (@octocat),@CAPCOM";
    const { container } = render(<MentionText text={text} />);
    await waitFor(() =>
      expect([...container.querySelectorAll(".mention")].map((el) => el.textContent)).toEqual([
        "@octocat",
        "@CAPCOM",
      ]),
    );
    expect(container.textContent).toBe(text);
  });
});
