import { STREAM_TEXT_MAX } from "@mc/core";
import { describe, expect, it } from "vitest";
import { cleanText, redactJwts } from "../src/clean.ts";

const ESC = "\u001b";

describe("cleanText", () => {
  it("removes ANSI escape sequences and C0 controls but keeps newlines and tabs", () => {
    expect(cleanText(`${ESC}[1;31mred${ESC}[0m plain`)).toBe("red plain");
    expect(cleanText(`${ESC}]0;title\u0007after`)).toBe("after");
    expect(cleanText(`${ESC}]8;;https://x.example${ESC}\\link${ESC}]8;;${ESC}\\`)).toBe("link");
    expect(cleanText(`a${ESC}7b${ESC}=c`)).toBe("abc");
    expect(cleanText("a\u0000b\u0007c\rd\u0008e\u001f")).toBe("abcde");
    expect(cleanText("line 1\n\tline 2")).toBe("line 1\n\tline 2");
  });

  it("redacts each credential pattern", () => {
    const cases: [string, string][] = [
      ["ghp_abcdefghijklmnopqrstuvwxyz012345", "[redacted]"],
      ["gho_ABCDEFGHIJKLMNOPQRSTUV", "[redacted]"],
      ["ghs_0123456789abcdefghij", "[redacted]"],
      ["github_pat_11ABCDEFG_0123456789abcdefghijkl", "[redacted]"],
      ["sk-ant-api03-abc_DEF-ghi0123456789xyz", "[redacted]"],
      ["sk-abcdefghij0123456789KLMN", "[redacted]"],
      ["xoxb-1234567890-abcdefghij", "[redacted]"],
      ["AKIAABCDEFGHIJKLMNOP", "[redacted]"],
      [
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
        "[redacted]",
      ],
      ["bearer abcdefghijklmnopqrstuvwxyz", "bearer [redacted]"],
      ["Authorization: Bearer abc.def-ghi_jkl.mnopqrstu", "Authorization: Bearer [redacted]"],
      ["TOKEN 0123456789abcdefghijKLMN", "TOKEN [redacted]"],
    ];
    for (const [input, out] of cases) {
      expect(cleanText(`x ${input} y`), input).toBe(`x ${out} y`);
    }
  });

  it("redacts a PEM private key block, and an unterminated one to the end", () => {
    const pem = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun",
      "VTLw7onLRnrq0/IzW7yWR7QkrmBL7jTKEn5u+qKhbwKfBstIs+bMY2Zkp18gnTxK",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    expect(cleanText(`before\n${pem}\nafter`)).toBe("before\n[redacted]\nafter");
    expect(cleanText("key: -----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC")).toBe(
      "key: [redacted]",
    );
  });

  it("leaves markup as the same string (the page renders it as text)", () => {
    const s = `<script>alert(1)</script><img src=x onerror="alert(2)">`;
    expect(cleanText(s)).toBe(s);
  });

  it(`cuts at ${STREAM_TEXT_MAX} characters with an ellipsis`, () => {
    const out = cleanText("a".repeat(5000));
    expect(out).toHaveLength(STREAM_TEXT_MAX);
    expect(out.endsWith("…")).toBe(true);
    expect(cleanText("a".repeat(STREAM_TEXT_MAX))).toBe("a".repeat(STREAM_TEXT_MAX));
  });

  it("handles a multi-megabyte input quickly, marking the cut even when cleaning shrinks it", () => {
    const big = `${ESC}[0m`.repeat(1_000_000);
    const start = performance.now();
    const out = cleanText(big);
    expect(performance.now() - start).toBeLessThan(200);
    expect(out).toBe("…");
  });

  it("never shows the unredacted start of a token cut by the input slice", () => {
    // A redaction shrinks the text, so the slice boundary lands inside the visible output.
    const pem = `-----BEGIN PRIVATE KEY-----\n${"A".repeat(STREAM_TEXT_MAX + 3000)}\n-----END PRIVATE KEY-----\n`;
    const s = `${pem}${"b".repeat(1030)} ghp_abcdefghijklmnopqrstuvwxyz012345`;
    expect(cleanText(s)).not.toContain("ghp_");
    // A long run of ordinary word characters is still shown up to the cut.
    expect(cleanText("w".repeat(20_000))).toBe(`${"w".repeat(STREAM_TEXT_MAX - 1)}…`);
  });

  it("cuts at a caller's own maximum; the default is unchanged", () => {
    expect(cleanText("a".repeat(50), 10)).toBe(`${"a".repeat(9)}…`);
    expect(cleanText("a".repeat(10), 10)).toBe("a".repeat(10));
    const long = "b".repeat(STREAM_TEXT_MAX + 10_000);
    expect(cleanText(long, STREAM_TEXT_MAX + 20_000)).toBe(long);
    expect(cleanText(long)).toHaveLength(STREAM_TEXT_MAX);
  });
});

describe("JWT redaction", () => {
  const JWT =
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";

  it("redacts a token amid text and leaves near-misses alone", () => {
    expect(redactJwts(`a ${JWT} b ${JWT}.`)).toBe("a [redacted] b [redacted].");
    expect(redactJwts("xeyJabc.def.ghi")).toBe("x[redacted]");
    for (const s of ["eyJabc.def", "eyJabc.def.", "eyJ.a.b", "eyJa..b", "eyJ.eyJ.eyJ"]) {
      expect(redactJwts(s), s).toBe(s);
    }
  });

  it("redacts adjacent tokens (one's third part running into the next header) whole", () => {
    const a = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl";
    const b = "eyJkZGRk.ZWVlZQ.ZmZmZg";
    expect(redactJwts(`${a}${b}`)).toBe("[redacted][redacted]");
    expect(redactJwts(`x ${a}${b} y`)).toBe("x [redacted][redacted] y");
    // an eyJ in a third part that does not start a whole token leaves one token
    expect(redactJwts("eyJa.b.ceyJd")).toBe("[redacted]");
    expect(redactJwts("eyJa.b.ceyJd.e")).toBe("[redacted].e");
    // an unsecured token (alg none, empty signature) running into a real one
    expect(redactJwts("eyJa.b.eyJd.e.f")).toBe("[redacted][redacted]");
  });

  it("takes a dash in any of the three parts, and both ends of each character range", () => {
    expect(redactJwts("eyJa-b.c.d")).toBe("[redacted]");
    expect(redactJwts("eyJab.c-d.e")).toBe("[redacted]");
    expect(redactJwts("eyJab.c.d-e")).toBe("[redacted]");
    expect(redactJwts("-eyJ-.-.-")).toBe("-[redacted]");
    const all = "AZaz09_-";
    expect(redactJwts(`x eyJ${all}.${all}.${all} y`)).toBe("x [redacted] y");
  });

  it("stops at characters that are not base64url: = and + stay", () => {
    expect(redactJwts("eyJa.b.c==")).toBe("[redacted]==");
    expect(redactJwts("eyJa.b.c++")).toBe("[redacted]++");
    expect(redactJwts("eyJa.b+c.d")).toBe("eyJa.b+c.d");
    expect(redactJwts("eyJa=b.c.d")).toBe("eyJa=b.c.d");
  });

  it("cleans an adversarial string 10x the 6 KB slice in linear time", () => {
    // with the max raised the slice is 64 KB; the old regex took ~0.5 s on this
    const s = "eyJ".repeat(21_000);
    const t = performance.now();
    cleanText(s, 60_000);
    expect(performance.now() - t).toBeLessThan(100);
  });

  it("scans a long adversarial string in linear time (the old regex took seconds)", () => {
    const s = "eyJ".repeat(70_000);
    const t = performance.now();
    redactJwts(s);
    expect(performance.now() - t).toBeLessThan(250);
  });
});
