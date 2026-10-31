import { describe, expect, it } from "vitest";
import { pickEncoding } from "../src/compress.ts";

describe("pickEncoding", () => {
  it("prefers brotli over gzip", () => {
    expect(pickEncoding("gzip, br")).toBe("br");
    expect(pickEncoding("gzip, deflate, br")).toBe("br");
  });

  it("ignores an encoding with q=0", () => {
    expect(pickEncoding("br;q=0, gzip")).toBe("gzip");
    expect(pickEncoding("br;q=0.0, gzip;q=0")).toBeNull();
  });

  it("returns null for identity, unknown tokens and no header", () => {
    expect(pickEncoding("identity")).toBeNull();
    expect(pickEncoding("zstd, deflate")).toBeNull();
    expect(pickEncoding(undefined)).toBeNull();
  });

  it("reads a repeated header", () => {
    expect(pickEncoding(["deflate", "gzip"])).toBe("gzip");
  });
});
