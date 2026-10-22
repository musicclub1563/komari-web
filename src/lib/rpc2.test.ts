import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../i18n/config", () => ({
  default: {
    t: (key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? key,
  },
}));

import {
  RPC2Client,
  RPC2BusinessError,
  RPC2ProtocolError,
  RPC2RequestNotSentError,
  RPC2RequestUnknownError,
  isReadOnlyRpcMethod,
} from "./rpc2";

type Listener = (event?: unknown) => void;

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  closed = false;
  url: string;
  onopen: Listener | null = null;
  onmessage: Listener | null = null;
  onclose: Listener | null = null;
  onerror: Listener | null = null;
  private listeners = new Map<string, Set<Listener>>();

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: Listener) {
    const set = this.listeners.get(type) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: Listener) {
    this.listeners.get(type)?.delete(listener);
  }

  private emit(type: string, event?: unknown) {
    for (const listener of Array.from(this.listeners.get(type) ?? [])) {
      listener(event);
    }
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
    this.emit("open");
  }

  send(data: string) {
    if (this.readyState !== FakeWebSocket.OPEN) {
      throw new Error("WebSocket is not open");
    }
    this.sent.push(data);
  }

  close() {
    this.closed = true;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
    this.emit("close");
  }

  /** 模拟服务端断开（触发 onclose）。 */
  serverClose() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  receive(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  lastRequest() {
    const raw = this.sent[this.sent.length - 1];
    return raw ? JSON.parse(raw) : undefined;
  }
}

type FetchCall = { url: string; body: any };

const fetchCalls: FetchCall[] = [];
let fetchResponses: Array<() => Promise<unknown>> = [];

const jsonResponse = (payload: unknown) =>
  ({
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => payload,
  }) as unknown as Response;

const createClient = (overrides: { requestTimeout?: number } = {}) =>
  new RPC2Client("/api/rpc2", {
    autoConnect: false,
    autoReconnect: false,
    enableHeartbeat: false,
    requestTimeout: overrides.requestTimeout ?? 200,
  });

const connectClient = async (client: RPC2Client) => {
  const pending = client.connect();
  const socket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  socket.open();
  await pending;
  return socket;
};

beforeEach(() => {
  FakeWebSocket.instances = [];
  fetchCalls.length = 0;
  fetchResponses = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("window", {
    location: { protocol: "http:", host: "komari.test" },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      fetchCalls.push({
        url,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      const next = fetchResponses.shift();
      if (!next) throw new Error("unexpected fetch call");
      return next();
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("isReadOnlyRpcMethod", () => {
  it("treats read methods as safe to retry", () => {
    expect(isReadOnlyRpcMethod("rpc.ping")).toBe(true);
    expect(isReadOnlyRpcMethod("common:getNodes")).toBe(true);
    expect(isReadOnlyRpcMethod("admin:listPlugins")).toBe(true);
    expect(isReadOnlyRpcMethod("common:getVersion")).toBe(true);
  });

  it("treats write methods as unsafe even when they contain read words", () => {
    expect(isReadOnlyRpcMethod("admin:getAndDeleteNode")).toBe(false);
    expect(isReadOnlyRpcMethod("admin:moveFiles")).toBe(false);
    expect(isReadOnlyRpcMethod("admin:copyFile")).toBe(false);
    expect(isReadOnlyRpcMethod("admin:deleteNode")).toBe(false);
    expect(isReadOnlyRpcMethod("admin:setPluginEnabled")).toBe(false);
    expect(isReadOnlyRpcMethod("admin:sendNotification")).toBe(false);
    expect(isReadOnlyRpcMethod("admin:migrateDatabase")).toBe(false);
    expect(isReadOnlyRpcMethod("terminal:exec")).toBe(false);
  });
});

describe("RPC2Client.call fallback policy", () => {
  it("does not replay a write when the response is lost", async () => {
    const client = createClient();
    const socket = await connectClient(client);

    const promise = client.call("admin:moveFiles", { from: "a", to: "b" }, { timeout: 20 });
    const request = socket.lastRequest();
    expect(request.method).toBe("admin:moveFiles");

    await expect(promise).rejects.toBeInstanceOf(RPC2RequestUnknownError);
    expect(fetchCalls).toHaveLength(0);
    expect(socket.sent).toHaveLength(1);
  });

  it("does not replay a write when the socket closes after sending", async () => {
    const client = createClient();
    const socket = await connectClient(client);

    const promise = client.call("admin:deleteNode", { uuid: "n1" }, { timeout: 500 });
    socket.serverClose();

    await expect(promise).rejects.toBeInstanceOf(RPC2RequestUnknownError);
    expect(fetchCalls).toHaveLength(0);
  });

  it("never replays a business error over HTTP", async () => {
    const client = createClient();
    const socket = await connectClient(client);

    const promise = client.call("admin:copyFiles", { paths: ["a"] });
    const request = socket.lastRequest();
    socket.receive({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32001, message: "target exists" },
    });

    await expect(promise).rejects.toBeInstanceOf(RPC2BusinessError);
    await expect(promise).rejects.toMatchObject({ code: -32001 });
    expect(fetchCalls).toHaveLength(0);
  });

  it("falls back to HTTP when the request was never sent", async () => {
    const client = createClient();
    const socket = await connectClient(client);
    // Connection state still says connected, but the socket is no longer writable.
    socket.readyState = FakeWebSocket.CLOSED;

    fetchResponses.push(async () => jsonResponse({ jsonrpc: "2.0", id: 99, result: "ok" }));

    await expect(client.call("admin:moveFiles", {})).resolves.toBe("ok");
    expect(fetchCalls).toHaveLength(1);
  });

  it("falls back to HTTP for read-only calls whose response was lost", async () => {
    const client = createClient();
    await connectClient(client);

    fetchResponses.push(async () => jsonResponse({ jsonrpc: "2.0", id: 42, result: ["n1"] }));

    await expect(
      client.call("common:getNodes", {}, { timeout: 20 }),
    ).resolves.toEqual(["n1"]);
    expect(fetchCalls).toHaveLength(1);
  });

  it("reports not-sent errors as such when there is no live socket", async () => {
    const client = createClient();

    await expect(
      client.callViaWebSocket("admin:moveFiles", {}),
    ).rejects.toBeInstanceOf(RPC2RequestNotSentError);
    expect(fetchCalls).toHaveLength(0);
  });

  it("does not replay a read-only call on business error", async () => {
    const client = createClient();
    const socket = await connectClient(client);

    const promise = client.call("common:getNodes");
    const request = socket.lastRequest();
    socket.receive({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32601, message: "method not found" },
    });

    await expect(promise).rejects.toBeInstanceOf(RPC2BusinessError);
    expect(fetchCalls).toHaveLength(0);
  });
});

describe("RPC2Client.reconnect", () => {
  it("rebuilds the connection and rejects in-flight requests without replaying them", async () => {
    const client = createClient();
    const firstSocket = await connectClient(client);

    const inFlight = client.call("admin:moveFiles", { from: "a", to: "b" }, { timeout: 1000 });
    expect(firstSocket.sent).toHaveLength(1);

    const reconnectPromise = client.reconnect();
    const secondSocket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    expect(secondSocket).not.toBe(firstSocket);
    secondSocket.open();
    await reconnectPromise;

    await expect(inFlight).rejects.toBeInstanceOf(RPC2RequestUnknownError);
    expect(firstSocket.closed).toBe(true);
    expect(fetchCalls).toHaveLength(0);
    expect(client.state).toBe("connected");

    // 新连接可用，且使用的仍是同一个客户端实例
    const promise = client.call("admin:moveFiles", { from: "b", to: "c" });
    const request = secondSocket.lastRequest();
    secondSocket.receive({ jsonrpc: "2.0", id: request.id, result: "done" });
    await expect(promise).resolves.toBe("done");
  });
});

describe("RPC2Client.batchCall", () => {
  it("accepts a single object response from the current backend", async () => {
    const client = createClient();
    fetchResponses.push(async () =>
      jsonResponse({ jsonrpc: "2.0", id: 1, result: { ok: true } }),
    );

    await expect(client.batchCall([{ method: "common:getNodes" }])).resolves.toEqual([
      { ok: true },
    ]);
    expect(fetchCalls[0].body).toHaveLength(1);
    expect(fetchCalls[0].body[0].id).toBe(1);
  });

  it("matches responses by request id instead of array order", async () => {
    const client = createClient();
    fetchResponses.push(async () =>
      jsonResponse([
        { jsonrpc: "2.0", id: 2, result: "second" },
        { jsonrpc: "2.0", id: 1, result: "first" },
      ]),
    );

    await expect(
      client.batchCall([{ method: "common:getNodes" }, { method: "common:getVersion" }]),
    ).resolves.toEqual(["first", "second"]);
  });

  it("surfaces JSON-RPC errors for the matching request", async () => {
    const client = createClient();
    fetchResponses.push(async () =>
      jsonResponse([
        { jsonrpc: "2.0", id: 1, result: "first" },
        { jsonrpc: "2.0", id: 2, error: { code: -32010, message: "denied" } },
      ]),
    );

    await expect(
      client.batchCall([{ method: "common:getNodes" }, { method: "admin:deleteNode" }]),
    ).rejects.toMatchObject({ code: -32010 });
  });

  it("reports a missing response instead of silently returning undefined", async () => {
    const client = createClient();
    fetchResponses.push(async () =>
      jsonResponse([{ jsonrpc: "2.0", id: 1, result: "first" }]),
    );

    await expect(
      client.batchCall([{ method: "common:getNodes" }, { method: "common:getVersion" }]),
    ).rejects.toBeInstanceOf(RPC2ProtocolError);
  });

  it("keeps notification slots and ignores their responses", async () => {
    const client = createClient();
    fetchResponses.push(async () =>
      jsonResponse([{ jsonrpc: "2.0", id: 1, result: "first" }]),
    );

    await expect(
      client.batchCall([
        { method: "common:getNodes" },
        { method: "admin:notify", notification: true },
      ]),
    ).resolves.toEqual(["first", undefined]);
    expect(fetchCalls[0].body[0].id).toBe(1);
    expect(fetchCalls[0].body[1].id).toBeUndefined();
  });

  it("throws batch-level errors returned with a null id", async () => {
    const client = createClient();
    fetchResponses.push(async () =>
      jsonResponse({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }),
    );

    await expect(client.batchCall([{ method: "common:getNodes" }])).rejects.toBeInstanceOf(
      RPC2BusinessError,
    );
  });
});
