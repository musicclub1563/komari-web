import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchOfficePreviewUrl } from "./fileManagerApi";
import {
  IDLE_OFFICE_PREVIEW,
  canStartOfficePreview,
  isOfficePreviewResultCurrent,
  officePreviewFor,
} from "./officePreview";

const OFFICE_VIEW_URL = "https://view.officeapps.live.com/op/view.aspx?src=";

describe("office preview consent gate", () => {
  it("requires an open dialog, an Office document and a path", () => {
    expect(canStartOfficePreview({ open: true, kind: "office", path: "/docs/a.xlsx" })).toBe(true);
    expect(canStartOfficePreview({ open: false, kind: "office", path: "/docs/a.xlsx" })).toBe(false);
    expect(canStartOfficePreview({ open: true, kind: "text", path: "/docs/a.txt" })).toBe(false);
    expect(canStartOfficePreview({ open: true, kind: "office", path: null })).toBe(false);
  });
});

describe("office preview state binding", () => {
  it("never reuses a preview from another file", () => {
    const preview = {
      path: "/docs/a.xlsx",
      status: "ready" as const,
      src: "https://view.officeapps.live.com/op/view.aspx?src=x",
      error: null,
    };
    expect(officePreviewFor(preview, "/docs/a.xlsx")).toBe(preview);
    expect(officePreviewFor(preview, "/docs/b.xlsx")).toBe(IDLE_OFFICE_PREVIEW);
    expect(officePreviewFor(preview, null)).toBe(IDLE_OFFICE_PREVIEW);
  });

  it("drops results that arrive after switching files or closing the panel", () => {
    expect(
      isOfficePreviewResultCurrent(
        { requestId: 3, path: "/docs/a.xlsx" },
        { requestId: 3, path: "/docs/a.xlsx" },
      ),
    ).toBe(true);
    expect(
      isOfficePreviewResultCurrent(
        { requestId: 3, path: "/docs/a.xlsx" },
        { requestId: 4, path: "/docs/a.xlsx" },
      ),
    ).toBe(false);
    expect(
      isOfficePreviewResultCurrent(
        { requestId: 3, path: "/docs/a.xlsx" },
        { requestId: 3, path: "/docs/b.xlsx" },
      ),
    ).toBe(false);
    expect(
      isOfficePreviewResultCurrent(
        { requestId: 3, path: "/docs/a.xlsx" },
        { requestId: 3, path: null },
      ),
    ).toBe(false);
  });
});

describe("fetchOfficePreviewUrl", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", {
      location: {
        origin: "https://komari.example",
        hostname: "komari.example",
      },
      localStorage: undefined,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const tokenResponse = (body: unknown, ok = true, status = 200) =>
    ({
      ok,
      status,
      json: async () => body,
    }) as unknown as Response;

  it("only asks for a token when explicitly called and returns the Office view URL", async () => {
    fetchMock.mockResolvedValue(tokenResponse({ data: { token: "test-token" } }));

    const url = await fetchOfficePreviewUrl("node-1", "/docs/报表.xlsx", new AbortController().signal);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [requestUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(requestUrl).toBe(
      "/api/admin/client/node-1/file/preview-token?path=%2Fdocs%2F%E6%8A%A5%E8%A1%A8.xlsx",
    );
    expect(init.credentials).toBe("include");
    expect(init.signal).toBeInstanceOf(AbortSignal);

    expect(url.startsWith(OFFICE_VIEW_URL)).toBe(true);
    const source = decodeURIComponent(url.slice(OFFICE_VIEW_URL.length));
    expect(source).toBe(
      "https://komari.example/api/preview/client/node-1/file/download?inline=1&preview_token=test-token&filename=komari-preview.xlsx",
    );
  });

  it("surfaces backend errors without producing an external URL", async () => {
    fetchMock.mockResolvedValue(tokenResponse({ message: "preview disabled" }, false, 403));

    await expect(fetchOfficePreviewUrl("node-1", "/docs/a.docx")).rejects.toThrow("preview disabled");
  });

  it("rejects when the response carries no token", async () => {
    fetchMock.mockResolvedValue(tokenResponse({ data: {} }));

    await expect(fetchOfficePreviewUrl("node-1", "/docs/a.docx")).rejects.toThrow(
      "Failed to create preview token",
    );
  });

  it("propagates cancellation from the caller", async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      expect(init?.signal).toBe(controller.signal);
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    });

    await expect(fetchOfficePreviewUrl("node-1", "/docs/a.docx", controller.signal)).rejects.toThrow();
  });
});
