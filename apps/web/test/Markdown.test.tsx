import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Markdown, MarkdownInline, MD_CODE_CLASS } from "../src/components/Markdown.tsx";

const html = (text: string) => render(<Markdown text={text} />).container;

describe("Markdown", () => {
  it("renders each construct as its element", () => {
    const c = html(
      [
        "# Plan",
        "",
        "First **bold** and `code` and [the docs](https://example.com/x).",
        "",
        "- one",
        "  - nested",
        "- two",
        "",
        "1. first",
        "2. second",
        "",
        "```ts",
        "const a = 1;",
        "```",
      ].join("\n"),
    );
    expect(c.querySelectorAll("p").length).toBe(2);
    expect(c.querySelector("p strong")?.textContent).toBe("Plan");
    expect(c.querySelector("p:nth-of-type(2) strong")?.textContent).toBe("bold");
    expect(c.querySelector("p code")?.textContent).toBe("code");
    expect(c.querySelectorAll("ul").length).toBe(2);
    expect(c.querySelectorAll("ul > li").length).toBe(3);
    expect(c.querySelector("ul ul li")?.textContent).toBe("nested");
    expect([...c.querySelectorAll("ol > li")].map((l) => l.textContent)).toEqual([
      "first",
      "second",
    ]);
    expect(c.querySelector("pre code")?.textContent).toBe("const a = 1;");
    const link = c.querySelector("[title='https://example.com/x']");
    expect(link?.textContent).toBe("the docs");
    expect(c.querySelector("a")).toBeNull();
  });

  it("shows raw HTML as literal text", () => {
    const c = html('<script>alert(1)</script>\n\n<img src=x onerror="alert(2)"> and **ok**');
    expect(c.querySelector("script")).toBeNull();
    expect(c.querySelector("img")).toBeNull();
    expect(c.textContent).toContain("<script>alert(1)</script>");
    expect(c.textContent).toContain('<img src=x onerror="alert(2)"> and ok');
  });

  it("keeps the markup of a code block inert", () => {
    const c = html("```\n<b>x</b>\n```");
    expect(c.querySelector("pre b")).toBeNull();
    expect(c.querySelector("pre")?.textContent).toBe("<b>x</b>");
  });

  it("gives the code block the scroll class", () => {
    expect(html("```\nx\n```").querySelector("pre")?.classList.contains(MD_CODE_CLASS)).toBe(true);
  });

  it("leaves plain text with the same text content", () => {
    const text = "Just a plain sentence, with punctuation.\nAnd a second line.";
    expect(html(text).textContent).toBe(text);
  });

  it("leaves prose with * _ 1. - and file names as written", () => {
    for (const text of [
      "Edited __init__.py and a*b, then 2*3 = 6 (see step 1. below) - done.",
      "snake_case_name, *not emphasis, and a - b; version 1.2.3",
      "In 2024. It was a good year.",
    ]) {
      expect(html(text).textContent).toBe(text);
    }
  });

  describe("numbered lists show the numbers written", () => {
    const nums = (text: string) =>
      [...html(text).querySelectorAll("li")].map((l) => (l as HTMLLIElement).value);

    it("across a blank line", () => {
      expect(nums("1. LRU\n\n2. TTL")).toEqual([1, 2]);
    });
    it("across a code block", () => {
      const c = html("1. Run:\n```\npnpm test\n```\n2. Check");
      expect([...c.querySelectorAll("li")].map((l) => l.value)).toEqual([1, 2]);
      expect(c.querySelector("pre")?.textContent).toBe("pnpm test");
    });
    it("from a number above 1", () => {
      const c = html("3. third\n4. fourth");
      expect(c.querySelector("ol")?.getAttribute("start")).toBe("3");
      expect(nums("3. third\n4. fourth")).toEqual([3, 4]);
    });
    it("but not a year", () => {
      const c = html("2024. It was a good year.");
      expect(c.querySelector("ol")).toBeNull();
      expect(c.textContent).toBe("2024. It was a good year.");
    });
    it("nested under a bullet or a number", () => {
      const c = html("- a\n  1. x\n  2. y\n- b");
      expect(c.querySelector("ul ol")).not.toBeNull();
      expect(c.querySelectorAll("ul ul").length).toBe(0);
    });
  });

  describe("fences lose no text", () => {
    it("```code``` on one line is inline code", () => {
      const c = html("```pnpm test```\nThen check.\n\nAll good.");
      expect(c.querySelector("code")?.textContent).toBe("pnpm test");
      expect(c.querySelector("pre")).toBeNull();
      expect(c.textContent).toContain("Then check.");
      expect(c.textContent).toContain("All good.");
    });
    it("a fence line with text after it does not close the block", () => {
      const c = html("```\na\n```js\nb\n```");
      expect(c.querySelectorAll("pre").length).toBe(1);
      expect(c.querySelector("pre")?.textContent).toBe("a\n```js\nb");
      const d = html("```\ncode\n``` and that is all\nafter");
      expect(d.querySelector("pre")?.textContent).toBe("code\n``` and that is all\nafter");
    });
    it("a four-backtick fence holds a three-backtick one", () => {
      const c = html("````\na\n```\nb\n````\nafter");
      expect(c.querySelector("pre")?.textContent).toBe("a\n```\nb");
      expect(c.querySelector("p")?.textContent).toBe("after");
    });
    it("tests the language tag on the trimmed info string", () => {
      expect(html("```ts \nx\n```").querySelector("pre")?.textContent).toBe("x");
      expect(html("``` ts\nx\n```").querySelector("pre")?.textContent).toBe("x");
      expect(html("```.txt\nx\n```").querySelector("pre")?.textContent).toBe("x");
    });
    it("an unclosed fence runs to the end", () => {
      expect(html("```\na\n\nb").querySelector("pre")?.textContent).toBe("a\n\nb");
    });
    it("text on the opening line that is not a language tag is code", () => {
      expect(html("```pnpm test\nok\n```").querySelector("pre")?.textContent).toBe("pnpm test\nok");
    });
    it("keeps every non-marker word of any mix of constructs", () => {
      const pieces = [
        "alpha",
        "beta",
        "gamma",
        "2024.",
        "```",
        "`",
        "**",
        "- ",
        "1. ",
        "# ",
        "\n",
        "\n\n",
        "  ",
        "<b>x</b>",
      ];
      const count = (s: string, w: string) => s.split(w).length - 1;
      let seed = 7;
      const rnd = (n: number) => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed % n;
      };
      for (let run = 0; run < 2000; run++) {
        const text = Array.from({ length: 1 + rnd(14) }, () => pieces[rnd(pieces.length)]).join(
          rnd(2) ? " " : "",
        );
        const markers = /[`*#]/g;
        const tags = new Set(
          text.split("\n").flatMap((l) => {
            const m = /^\s*`{3,}\s*([\w+#.-]+)\s*$/.exec(l);
            return m?.[1] ? [m[1]] : [];
          }),
        );
        const c = html(text);
        const out = (c.textContent ?? "").replace(markers, "");
        // the same text with the blocks apart, so two neighbours cannot make a word the text lacks
        const walk = document.createTreeWalker(c, NodeFilter.SHOW_TEXT);
        const parts: string[] = [];
        for (let n = walk.nextNode(); n; n = walk.nextNode()) parts.push(n.textContent ?? "");
        const shown = parts.join("\n").replace(markers, "");
        for (const tok of text.split(/\s+/)) {
          const word = tok.replace(markers, "");
          if (word === "" || word === "-" || /^\d{1,3}\.$/.test(word)) continue;
          // a language tag right after the fence (```alpha) is the one thing dropped
          if (tags.has(word)) continue;
          expect(out, JSON.stringify(text)).toContain(word);
          // and none is shown more often than it was written
          expect(count(shown, word), JSON.stringify(text)).toBeLessThanOrEqual(
            count(text.replace(markers, ""), word),
          );
        }
      }
    });
  });

  describe("inline markers", () => {
    const strongs = (text: string) =>
      [...html(text).querySelectorAll("strong")].map((e) => e.textContent);
    it("nested bold nests, as CommonMark has it", () => {
      expect(html("**a **b** c**").innerHTML).toBe(
        '<div class="md"><p><strong>a <strong>b</strong> c</strong></p></div>',
      );
    });
    it("a run of stars is one marker", () => {
      expect(html("****x****").textContent).toBe("x");
      expect(strongs("****x****")).toEqual(["x"]);
    });
    it("a run of three holds its odd star on both sides", () => {
      const c = html("***x***");
      expect(c.textContent).toBe("*x*");
      expect(strongs("***x***")).toEqual(["*x*"]);
    });
    it("an unpaired ** stays as written", () => {
      expect(html("a ** b").textContent).toBe("a ** b");
      expect(strongs("**a** and ** b")).toEqual(["a"]);
    });
    it("a ** that cannot open is the one left unpaired", () => {
      const c = html("Use ** for bold, like **this**.");
      expect(c.textContent).toBe("Use ** for bold, like this.");
      expect(strongs("Use ** for bold, like **this**.")).toEqual(["this"]);
      expect(strongs("**a `b** c` and **d**")).toEqual(["d"]);
      // a ** before a space cannot open, so a later ** cannot close it
      expect(html("a ** b**").querySelector("strong")).toBeNull();
      expect(html("a ** b**").textContent).toBe("a ** b**");
    });
    it("star masks show as written", () => {
      for (const text of [
        "token ghp_****",
        "password: ****, user: ****",
        "a****b",
        "**** and ****",
      ]) {
        const c = html(text);
        expect(c.textContent).toBe(text);
        expect(c.querySelector("strong")).toBeNull();
      }
    });
    it("a code span pads with one space each side that is dropped", () => {
      expect(html("`` `x` ``").querySelector("code")?.textContent).toBe("`x`");
      expect(html("` a `").querySelector("code")?.textContent).toBe("a");
      expect(html("`  `").querySelector("code")?.textContent).toBe("  ");
    });
    it("code spans bind tighter than links", () => {
      const c = html("[`a](b)`");
      expect(c.textContent).toBe("[a](b)");
      expect(c.querySelector("code")?.textContent).toBe("a](b)");
      expect(c.querySelector("[title]")).toBeNull();
      expect(html("[`a`](u)").querySelector("[title='u'] code")?.textContent).toBe("a");
      // a ] inside code does not close the link text
      const d = html("[a `b] c` d](u)");
      expect(d.querySelector("[title='u'] code")?.textContent).toBe("b] c");
      expect(d.textContent).toBe("a b] c d");
      // nor does a ) inside code close the URL
      expect(html("[x](a`)`b)").querySelector("[title]")?.getAttribute("title")).toBe("a`)`b");
    });
    it("code binds tighter than bold", () => {
      const c = html("**a `b** c`");
      expect(c.textContent).toBe("**a b** c");
      expect(c.querySelector("code")?.textContent).toBe("b** c");
      expect(c.querySelector("strong")).toBeNull();
    });
    it("an unpaired backtick in bold stays as written", () => {
      expect(html("**a `b** c").textContent).toBe("a `b c");
    });
    it("a triple-backtick span mid-line has no stray backticks", () => {
      const c = html("Run ```pnpm test``` now");
      expect(c.textContent).toBe("Run pnpm test now");
      expect(c.querySelector("code")?.textContent).toBe("pnpm test");
    });
    it("a longer run does not close a shorter one", () => {
      expect(html("``a ` b``").querySelector("code")?.textContent).toBe("a ` b");
    });
  });

  describe("links", () => {
    it("keep a URL with parentheses whole", () => {
      const c = html("see [Foo](https://en.wikipedia.org/wiki/Foo_(bar)) here");
      expect(c.querySelector("[title]")?.getAttribute("title")).toBe(
        "https://en.wikipedia.org/wiki/Foo_(bar)",
      );
      expect(c.textContent).toBe("see Foo here");
    });
    it("parse their text as inline Markdown", () => {
      const c = html("[**x** and `y`](u)");
      expect(c.querySelector("[title='u'] strong")?.textContent).toBe("x");
      expect(c.querySelector("[title='u'] code")?.textContent).toBe("y");
      expect(c.textContent).toBe("x and y");
    });
    it("without a URL stay as written", () => {
      expect(html("[a](b c) and [d]() and [e]").textContent).toBe("[a](b c) and [d]() and [e]");
    });
    it("render a long run of [ as written", () => {
      const text = "[".repeat(100_000);
      expect(render(<MarkdownInline text={text} />).container.textContent).toBe(text);
    });
  });

  describe("long runs of markers render in linear time", () => {
    // `grow` times the text may take about `grow` times as long; a quadratic scan takes `grow`²
    // times. Units that render to a few elements can grow further without a slow DOM.
    const best = (unit: string, n: number) => {
      const text = unit.repeat(n);
      let ms = Number.POSITIVE_INFINITY;
      for (let rep = 0; rep < 3; rep++) {
        const t0 = performance.now();
        render(<MarkdownInline text={text} />).unmount();
        ms = Math.min(ms, performance.now() - t0);
      }
      return ms;
    };
    const units: [string, number][] = [
      ["[", 100],
      ["(", 100],
      ["[a](", 100],
      ["** ", 100],
      ["`", 25],
      ["``` ", 25],
      ["**a ", 25],
      ["**a** ", 25],
      ["[a]**", 25],
    ];
    for (const [unit, grow] of units) {
      it(JSON.stringify(unit), () => {
        const n = Math.ceil(4000 / unit.length);
        best(unit, n);
        expect(best(unit, n * grow)).toBeLessThan(best(unit, n) * grow * 3 + 20);
      }, 60_000);
    }
  });

  describe("headings", () => {
    it("## and deeper are headings", () => {
      expect(html("## Plan: phase 1").querySelector("p strong")?.textContent).toBe("Plan: phase 1");
    });
    it("a short # line is a heading", () => {
      expect(html("# Plan").querySelector("p strong")?.textContent).toBe("Plan");
    });
    it("a # line that reads as prose keeps its #", () => {
      const c = html("# of retries: 3");
      expect(c.querySelector("strong")).toBeNull();
      expect(c.textContent).toBe("# of retries: 3");
      expect(html(`# ${"word ".repeat(20)}`).querySelector("strong")).toBeNull();
    });
  });

  describe("lists", () => {
    it("keep an indented continuation line in the item", () => {
      const c = html("- a\n  more of a\n- b");
      expect(c.querySelectorAll("p").length).toBe(0);
      const li = c.querySelectorAll("li");
      expect(li.length).toBe(2);
      expect(li[0]?.innerHTML).toBe("a<br>more of a");
    });
    it("keep a continuation line in a numbered item", () => {
      const c = html("1. a\n   more\n2. b");
      expect(c.querySelectorAll("p").length).toBe(0);
      expect([...c.querySelectorAll("li")].map((l) => l.innerHTML)).toEqual(["a<br>more", "b"]);
    });
    it("end at an unindented line", () => {
      expect(html("- a\nafter").querySelector("p")?.textContent).toBe("after");
    });
    it("keep each marker type when bullets and numbers mix", () => {
      const tags = (text: string) =>
        [...(html(text).children[0]?.children ?? [])].map((e) => e.tagName);
      expect(tags("- a\n1. b")).toEqual(["UL", "OL"]);
      expect(tags("1. a\n- b")).toEqual(["OL", "UL"]);
    });
    it("keep each marker type when nested", () => {
      const c = html("- a\n  1. x\n  - y\n- b");
      expect(c.querySelectorAll("ul > li > ol").length).toBe(1);
      expect(c.querySelectorAll("ul > li > ul").length).toBe(1);
    });
  });

  describe("MarkdownInline max", () => {
    const cut = (text: string, max: number) =>
      render(<MarkdownInline text={text} max={max} />).container;
    it("keeps text of exactly max whole and cuts one over", () => {
      expect(cut("abcde", 5).textContent).toBe("abcde");
      expect(cut("abcdef", 5).textContent).toBe("abcd…");
      expect(cut("ab**cd**", 4).textContent).toBe("abcd");
      expect(cut("ab**cde**", 4).textContent).toBe("abc…");
      // a piece that fills the budget exactly is kept, the cut falls on the next one
      const c = cut("ab**cde**fg", 6);
      expect(c.textContent).toBe("abcde…");
      expect(c.querySelector("strong")?.textContent).toBe("cde");
    });
    it("cuts inside code without leaving a literal backtick", () => {
      const c = cut("**see `pnpm test` now**", 8);
      expect(c.textContent).toBe("see pnp…");
      expect(c.querySelector("strong code")?.textContent).toBe("pnp…");
    });
    it("cuts inside a link keeping its URL", () => {
      const c = cut("[the long docs page](https://x.test/a)", 8);
      expect(c.textContent).toBe("the lon…");
      expect(c.querySelector("[title='https://x.test/a']")).not.toBeNull();
    });
    it("counts code points, not UTF-16 units", () => {
      expect(cut("😀😀😀", 2).textContent).toBe("😀…");
      expect(cut("😀😀😀", 3).textContent).toBe("😀😀😀");
      expect(cut("**😀😀**😀", 3).textContent).toBe("😀😀😀");
      expect(cut("`😀😀😀`", 3).textContent).toBe("😀😀😀");
    });
  });

  describe("plain prose in inline text", () => {
    it("keeps the text of a question part or run summary as written", () => {
      for (const text of [
        "Should we use 2 * 3 or a*b? (yes) [maybe] - see #12.",
        "Ran 3 steps; ok. snake_case and file.txt, 100% done",
        "# of retries: 3",
      ]) {
        expect(render(<MarkdownInline text={text} />).container.textContent).toBe(text);
      }
    });
    it("keeps a # line that reads as prose through the block renderer", () => {
      for (const text of ["# of retries: 3", "# of retries: 3\nand more"]) {
        const c = html(text);
        expect(c.textContent).toBe(text);
        expect(c.querySelector("strong")).toBeNull();
      }
    });
  });
});
