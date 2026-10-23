import { describe, expect, it } from "vitest";
import {
  MAX_INLINE_SVG_BYTES,
  assessIconSource,
  isAllowedIconSource,
  normalizeIconSource,
} from "./iconSource";

describe("icon source allowlist", () => {
  it("accepts site-relative, http(s) and protocol-relative URLs", () => {
    expect(isAllowedIconSource("/api/admin/plugin/demo/icon.svg")).toBe(true);
    expect(isAllowedIconSource("/komari/api/admin/plugin/demo/icon.svg")).toBe(true);
    expect(isAllowedIconSource("./icon.svg")).toBe(true);
    expect(isAllowedIconSource("../assets/icon.svg")).toBe(true);
    expect(isAllowedIconSource("https://cdn.example.com/icon.svg")).toBe(true);
    expect(isAllowedIconSource("http://cdn.example.com/icon.png")).toBe(true);
    expect(isAllowedIconSource("//cdn.example.com/icon.svg")).toBe(true);
  });

  it("accepts raster data URLs", () => {
    expect(isAllowedIconSource("data:image/png;base64,iVBORw0KGgo=")).toBe(true);
    expect(isAllowedIconSource("data:image/webp;base64,UklGRg==")).toBe(true);
    expect(isAllowedIconSource("data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E")).toBe(true);
  });

  it("rejects dangerous protocols", () => {
    expect(isAllowedIconSource("javascript:alert(1)")).toBe(false);
    expect(isAllowedIconSource("JavaScript:alert(1)")).toBe(false);
    expect(isAllowedIconSource("vbscript:msgbox(1)")).toBe(false);
    expect(isAllowedIconSource("data:text/html,<script>alert(1)</script>")).toBe(false);
    expect(isAllowedIconSource("data:application/xhtml+xml,<script/>")).toBe(false);
    expect(isAllowedIconSource("file:///etc/passwd")).toBe(false);
    expect(isAllowedIconSource("")).toBe(false);
  });

  it("rejects protocol obfuscated with control characters or whitespace", () => {
    expect(isAllowedIconSource("java\nscript:alert(1)")).toBe(false);
    expect(isAllowedIconSource("java\tscript:alert(1)")).toBe(false);
    expect(isAllowedIconSource("\u0000javascript:alert(1)")).toBe(false);
    expect(isAllowedIconSource("java\u0001script:alert(1)")).toBe(false);
    expect(isAllowedIconSource("  javascript:alert(1)  ")).toBe(false);
    expect(normalizeIconSource("java\nscript:alert(1)")).toBe("javascript:alert(1)");
  });

  it("rejects entity-encoded protocol prefixes", () => {
    expect(isAllowedIconSource("&#106;avascript:alert(1)")).toBe(false);
    expect(isAllowedIconSource("&#x6a;avascript:alert(1)")).toBe(false);
    expect(isAllowedIconSource("&amp;javascript:alert(1)")).toBe(false);
  });

  it("enforces the inline payload size cap", () => {
    const oversized = `data:image/svg+xml,${"A".repeat(MAX_INLINE_SVG_BYTES)}`;
    const assessment = assessIconSource(oversized);
    expect(assessment.allowed).toBe(false);
    expect(assessment.rejection).toBe("too-large");
    expect(isAllowedIconSource(oversized)).toBe(false);
  });

  it("reports why a source was rejected", () => {
    expect(assessIconSource("").rejection).toBe("empty");
    expect(assessIconSource("javascript:1").rejection).toBe("unsupported-protocol");
  });
});
