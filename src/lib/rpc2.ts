import type {
  JSONRPC2Request,
  JSONRPC2Response,
  JSONRPC2BatchRequest,
  RPC2ConnectionStateType,
  RPC2ConnectionOptions,
  RPC2CallOptions,
  RPC2EventListeners,
} from "../types/rpc2";
import { RPC2ConnectionState } from "../types/rpc2";
import i18n from "../i18n/config";

/**
 * 错误分类。调用方据此判断是否可以安全地重试。
 */
export type RPC2ErrorKind =
  /** 服务端返回了明确的 JSON-RPC 业务错误（请求已被处理并失败） */
  | "business"
  /** 请求在发送到服务端之前就失败了（未发生任何副作用，可安全重试） */
  | "not-sent"
  /** 请求已发送但结果未知（超时、连接中断），不得假定操作未执行 */
  | "unknown-outcome"
  /** 响应结构不符合 JSON-RPC 2.0 协议（例如缺少数值/字段异常） */
  | "protocol";

export class RPC2Error extends Error {
  readonly kind: RPC2ErrorKind;

  constructor(kind: RPC2ErrorKind, message: string) {
    super(message);
    this.name = "RPC2Error";
    this.kind = kind;
  }
}

/**
 * 服务端返回了 JSON-RPC error。业务错误代表服务端已处理过该请求，
 * 因此绝不能通过 HTTP 重发同一方法。
 */
export class RPC2BusinessError extends RPC2Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super("business", `RPC Error ${code}: ${message}`);
    this.name = "RPC2BusinessError";
    this.code = code;
    this.data = data;
  }
}

/** 请求未被发送（WebSocket 未打开或 send 抛错），可安全重试。 */
export class RPC2RequestNotSentError extends RPC2Error {
  constructor(message: string) {
    super("not-sent", message);
    this.name = "RPC2RequestNotSentError";
  }
}

/**
 * 请求已发送但结果未知（超时、连接关闭、身份切换导致连接重建）。
 * 对写操作必须提示用户刷新确认，不能自动重放。
 */
export class RPC2RequestUnknownError extends RPC2Error {
  constructor(message: string) {
    super("unknown-outcome", message);
    this.name = "RPC2RequestUnknownError";
  }
}

/** 响应不符合预期结构。 */
export class RPC2ProtocolError extends RPC2Error {
  constructor(message: string) {
    super("protocol", message);
    this.name = "RPC2ProtocolError";
  }
}

/** 判断错误是否表示“结果未知”（写操作需要用户刷新确认）。 */
export function isRPC2UnknownOutcome(error: unknown): error is RPC2RequestUnknownError {
  return error instanceof RPC2RequestUnknownError;
}

const WRITE_WORDS = new Set([
  "add",
  "apply",
  "approve",
  "assign",
  "bind",
  "cancel",
  "clear",
  "copy",
  "create",
  "del",
  "delete",
  "destroy",
  "disable",
  "dismiss",
  "drop",
  "edit",
  "enable",
  "exec",
  "execute",
  "import",
  "insert",
  "install",
  "kill",
  "login",
  "logout",
  "mark",
  "merge",
  "migrate",
  "move",
  "notify",
  "patch",
  "publish",
  "purge",
  "reboot",
  "reload",
  "remove",
  "rename",
  "replace",
  "reset",
  "restart",
  "restore",
  "resume",
  "revoke",
  "run",
  "save",
  "send",
  "set",
  "shutdown",
  "start",
  "stop",
  "submit",
  "suspend",
  "sync",
  "toggle",
  "trigger",
  "uninstall",
  "update",
  "upload",
  "write",
]);

const READ_WORDS = new Set([
  "count",
  "describe",
  "fetch",
  "find",
  "get",
  "has",
  "info",
  "is",
  "list",
  "me",
  "metrics",
  "ping",
  "query",
  "read",
  "search",
  "stats",
  "status",
  "version",
]);

function methodWords(method: string): string[] {
  const separator = method.indexOf(":");
  const name = separator >= 0 ? method.slice(separator + 1) : method;
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

/**
 * 保守判断某个 RPC 方法是否只读。
 *
 * 只有动词明确属于读取类、且不含任何写入类动词时才返回 true；
 * 其余情况一律按“写操作”处理，禁止自动重放。
 */
export function isReadOnlyRpcMethod(method: string): boolean {
  if (method === "rpc.ping") return true;
  const words = methodWords(method);
  if (words.length === 0) return false;
  if (words.some((word) => WRITE_WORDS.has(word))) return false;
  return READ_WORDS.has(words[0]);
}

/**
 * RPC2 客户端类
 * 支持通过 WebSocket 和 HTTP POST 调用 JSON-RPC 2.0 接口
 */
export class RPC2Client {
  private ws: WebSocket | null = null;
  private connectionState: RPC2ConnectionStateType = RPC2ConnectionState.DISCONNECTED;
  private requestId = 0;
  private pendingRequests = new Map<string | number, {
    resolve: (value: any) => void;
    reject: (reason?: any) => void;
    timeout?: NodeJS.Timeout;
  }>();
  private reconnectAttempts = 0;
  private reconnectTimeout?: NodeJS.Timeout;
  private heartbeatInterval?: NodeJS.Timeout;
  private stableConnectionTimeout?: NodeJS.Timeout;
  private manualDisconnect = false;
  private connectionGeneration = 0;
  private eventListeners: RPC2EventListeners = {};

  // Do not reset the retry counter for a connection that immediately flaps.
  private readonly stableConnectionWindow = 10000;

  private readonly baseUrl: string;
  private readonly options: Required<RPC2ConnectionOptions>;

  constructor(
    baseUrl = "/api/rpc2",
    options: RPC2ConnectionOptions = {}
  ) {
    this.baseUrl = baseUrl;
    this.options = {
      autoConnect: true,
      autoReconnect: true,
      reconnectInterval: 3000,
      maxReconnectAttempts: 5,
      requestTimeout: 30000,
      enableHeartbeat: true,
      heartbeatInterval: 15000,
      headers: {
        "Content-Type": "application/json",
      },
      ...options,
    };

    // 自动建立连接
    if (this.options.autoConnect) {
      this.autoConnect();
    }
  }

  /**
   * 获取当前连接状态
   */
  get state(): RPC2ConnectionStateType {
    return this.connectionState;
  }

  /**
   * 设置事件监听器
   */
  setEventListeners(listeners: RPC2EventListeners): void {
    this.eventListeners = { ...this.eventListeners, ...listeners };
  }

  clearEventListeners(): void {
    this.eventListeners = {};
  }

  /**
   * 建立 WebSocket 连接
   */
  async connect(): Promise<void> {
    if (this.connectionState === RPC2ConnectionState.CONNECTED ||
        this.connectionState === RPC2ConnectionState.CONNECTING) {
      return;
    }

    this.manualDisconnect = false;
    const generation = ++this.connectionGeneration;
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = undefined;
    }
    this.setConnectionState(RPC2ConnectionState.CONNECTING);

    let socket: WebSocket | null = null;
    try {
      const wsUrl = this.getWebSocketUrl();
      socket = new WebSocket(wsUrl);
      this.ws = socket;
      this.setupWebSocketHandlers(socket);

      // 等待连接建立（不覆盖已设置的处理器，避免丢失心跳与状态更新）
      await new Promise<void>((resolve, reject) => {
        const handleOpen = () => {
          cleanup();
          resolve();
        };
        const handleError = () => {
          cleanup();
          reject(new Error(i18n.t("rpc2.websocket_connection_failed")));
        };
        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error(i18n.t("rpc2.websocket_connection_timed_out")));
        }, 10000);

        const cleanup = () => {
          clearTimeout(timeout);
          socket?.removeEventListener("open", handleOpen);
          socket?.removeEventListener("error", handleError);
        };

        socket?.addEventListener("open", handleOpen, { once: true });
        socket?.addEventListener("error", handleError, { once: true });
      });
    } catch (error) {
      if (generation !== this.connectionGeneration) {
        socket?.close();
        throw error;
      }
      if (socket && this.ws === socket) {
        // A failed opening handshake does not always emit close in every
        // browser, so close and detach it here before scheduling a retry.
        this.ws = null;
        if (socket.readyState !== WebSocket.CLOSED) {
          socket.close();
        }
      } else if (socket) {
        socket.close();
      }
      this.stopHeartbeat();
      if (this.stableConnectionTimeout) {
        clearTimeout(this.stableConnectionTimeout);
        this.stableConnectionTimeout = undefined;
      }
      this.setConnectionState(RPC2ConnectionState.DISCONNECTED);
      this.eventListeners.onError?.(error as Error);
      if (!this.manualDisconnect && this.options.autoReconnect &&
          this.reconnectAttempts < this.options.maxReconnectAttempts) {
        this.attemptReconnect();
      }
      throw error;
    }
  }

  /**
   * 自动建立连接（非阻塞）
   */
  private autoConnect(): void {
    if (this.manualDisconnect || this.connectionState !== RPC2ConnectionState.DISCONNECTED) {
      return;
    }

    // 异步尝试连接，不阻塞构造函数
    this.connect().catch((error) => {
      console.warn(i18n.t("rpc2.automatic_connection_failed"), error.message);
      // 连接失败时，如果启用了自动重连，会在 onclose 处理器中进行重连
    });
  }

  /**
   * 断开 WebSocket 连接
   */
  disconnect(): void {
    this.manualDisconnect = true;
    this.connectionGeneration++;
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = undefined;
    }

    // 清理心跳包定时器
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
    }

    if (this.stableConnectionTimeout) {
      clearTimeout(this.stableConnectionTimeout);
      this.stableConnectionTimeout = undefined;
    }

    const socket = this.ws;
    this.ws = null;
    if (socket) {
      socket.close();
    }

    this.setConnectionState(RPC2ConnectionState.DISCONNECTED);
    this.clearPendingRequests(this.createUnknownOutcomeError("connection_disconnected"));
  }

  /**
   * 使用最新的 Cookie/身份重新建立 WebSocket 连接。
   *
   * 登录、退出登录或身份失效后必须调用：Komari 服务端在握手时固定连接身份，
   * 仅仅更换 Cookie 不会让已建立的连接获得新身份。
   *
   * 旧连接上尚未完成的请求会以 "unknown-outcome" 拒绝，绝不静默重放写操作。
   */
  async reconnect(): Promise<void> {
    this.disconnect();
    this.reconnectAttempts = 0;
    await this.connect();
  }

  /**
   * 通过 WebSocket 调用 RPC 方法
   */
  async callViaWebSocket<TParams = any, TResult = any>(
    method: string,
    params?: TParams,
    options: RPC2CallOptions = {}
  ): Promise<TResult> {
    if (this.connectionState !== RPC2ConnectionState.CONNECTED) {
      throw new RPC2RequestNotSentError(i18n.t("rpc2.websocket_not_connected"));
    }

    const request: JSONRPC2Request<TParams> = {
      jsonrpc: "2.0",
      method,
      params,
      id: options.notification ? undefined : this.generateRequestId(),
    };

    if (options.notification) {
      // 通知请求，不期望响应
      this.sendMessage(request);
      return undefined as TResult;
    }

    return new Promise<TResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(request.id!);
        // 已经写入 socket，服务端可能已执行，只是响应没有回来。
        reject(
          new RPC2RequestUnknownError(
            i18n.t("rpc2.result_unknown", {
              method,
              defaultValue:
                "Request timed out; the server may have completed it. Refresh to confirm the result.",
            }),
          ),
        );
      }, options.timeout || this.options.requestTimeout);

      this.pendingRequests.set(request.id!, {
        resolve,
        reject,
        timeout,
      });

      try {
        this.sendMessage(request);
      } catch (error) {
        this.pendingRequests.delete(request.id!);
        clearTimeout(timeout);
        reject(this.toNotSentError(error));
      }
    });
  }

  /**
   * 通过 HTTP POST 调用 RPC 方法
   */
  async callViaHTTP<TParams = any, TResult = any>(
    method: string,
    params?: TParams,
    options: RPC2CallOptions = {}
  ): Promise<TResult> {
    const request: JSONRPC2Request<TParams> = {
      jsonrpc: "2.0",
      method,
      params,
      id: options.notification ? undefined : this.generateRequestId(),
    };
    const requestAbort = this.createRequestAbort(
      options.timeout || this.options.requestTimeout,
    );

    try {
      const response = await fetch(this.baseUrl, {
        method: "POST",
        headers: this.options.headers,
        body: JSON.stringify(request),
        signal: requestAbort.signal,
      });

      if (!response.ok) {
        // 服务端已响应（说明请求到达了服务端），不重放。
        throw new RPC2BusinessError(
          response.status,
          `${response.statusText || "HTTP error"} (HTTP ${response.status})`,
        );
      }

      if (options.notification) {
        return undefined as TResult;
      }

      const jsonResponse: JSONRPC2Response<TResult> = await response.json();

      if ("error" in jsonResponse && jsonResponse.error) {
        throw new RPC2BusinessError(
          jsonResponse.error.code,
          jsonResponse.error.message,
          jsonResponse.error.data,
        );
      }

      if (!jsonResponse || typeof jsonResponse !== "object" || !("result" in jsonResponse)) {
        throw new RPC2ProtocolError(
          i18n.t("rpc2.invalid_response", {
            method,
            defaultValue: "Malformed JSON-RPC response",
          }),
        );
      }

      return jsonResponse.result;
    } catch (error) {
      if (error instanceof RPC2Error) {
        throw error;
      }
      // fetch 拒绝：可能是未发出，也可能是发出后连接中断，按“结果未知”处理。
      throw new RPC2RequestUnknownError(
        i18n.t("rpc2.result_unknown", {
          method,
          defaultValue:
            "Request failed after being sent; the server may have completed it. Refresh to confirm the result.",
        }),
      );
    } finally {
      requestAbort.clear();
    }
  }

  /**
   * 批量调用（仅支持 HTTP）
   *
   * 兼容当前服务端在“只有一个响应”时返回单个对象而非数组的行为，
   * 并按请求 ID 关联结果，不依赖响应顺序。
   */
  async batchCall(requests: Array<{
    method: string;
    params?: any;
    notification?: boolean;
  }>): Promise<any[]> {
    if (!Array.isArray(requests) || requests.length === 0) {
      return [];
    }

    const requestIds: Array<string | number | undefined> = [];
    const batchRequest: JSONRPC2BatchRequest = requests.map((req) => {
      const id = req.notification ? undefined : this.generateRequestId();
      requestIds.push(id);
      return {
        jsonrpc: "2.0" as const,
        method: req.method,
        params: req.params,
        id,
      };
    });
    const requestAbort = this.createRequestAbort(this.options.requestTimeout);

    try {
      const response = await fetch(this.baseUrl, {
        method: "POST",
        headers: this.options.headers,
        body: JSON.stringify(batchRequest),
        signal: requestAbort.signal,
      });

      if (!response.ok) {
        throw new RPC2BusinessError(
          response.status,
          `${response.statusText || "HTTP error"} (HTTP ${response.status})`,
        );
      }

      const raw: unknown = await response.json();
      const items: unknown[] = Array.isArray(raw)
        ? raw
        : raw && typeof raw === "object"
          ? [raw]
          : [];

      const responsesById = new Map<string | number, JSONRPC2Response>();
      for (const item of items) {
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        const candidate = item as JSONRPC2Response;
        if (candidate.id === undefined || candidate.id === null) continue;
        responsesById.set(candidate.id, candidate);
      }

      // 批量/整体错误（例如解析失败时 id 为 null）
      for (const item of items) {
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        const candidate = item as JSONRPC2Response;
        if (candidate.id !== null && candidate.id !== undefined) continue;
        if ("error" in candidate && candidate.error) {
          throw new RPC2BusinessError(
            candidate.error.code,
            candidate.error.message,
            candidate.error.data,
          );
        }
      }

      return requests.map((req, index) => {
        if (req.notification) return undefined;
        const id = requestIds[index];
        const matched = id === undefined ? undefined : responsesById.get(id);
        if (!matched) {
          throw new RPC2ProtocolError(
            i18n.t("rpc2.batch_missing_response", {
              method: req.method,
              id,
              defaultValue: `Missing JSON-RPC response for ${req.method} (id=${String(id)})`,
            }),
          );
        }
        if ("error" in matched && matched.error) {
          throw new RPC2BusinessError(
            matched.error.code,
            matched.error.message,
            matched.error.data,
          );
        }
        if (!("result" in matched)) {
          throw new RPC2ProtocolError(
            i18n.t("rpc2.invalid_response", {
              method: req.method,
              defaultValue: "Malformed JSON-RPC response",
            }),
          );
        }
        return matched.result;
      });
    } catch (error) {
      if (error instanceof RPC2Error) {
        throw error;
      }
      throw new RPC2RequestUnknownError(
        i18n.t("rpc2.batch_request_failed", {
          defaultValue:
            "Batch request failed after being sent; the server may have completed it. Refresh to confirm the result.",
        }),
      );
    } finally {
      requestAbort.clear();
    }
  }

  /**
   * AbortSignal.timeout() is unavailable in older browsers and WebViews.
   */
  private createRequestAbort(timeout: number): {
    signal: AbortSignal;
    clear: () => void;
  } {
    const timeoutSignal = AbortSignal as typeof AbortSignal & {
      timeout?: (milliseconds: number) => AbortSignal;
    };

    if (typeof timeoutSignal.timeout === "function") {
      return {
        signal: timeoutSignal.timeout(timeout),
        clear: () => undefined,
      };
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    return {
      signal: controller.signal,
      clear: () => clearTimeout(timeoutId),
    };
  }

  /**
   * 自动选择调用方式（优先使用 WebSocket）
   *
   * 回退策略（按错误类型区分，避免写操作被重复提交）：
   * 1) 业务错误 → 直接抛出，绝不重发；
   * 2) 发送前失败（未写入 socket）→ 允许一次 HTTP 回退（没有产生副作用）；
   * 3) 已发送但结果未知（超时/连接中断）→ 仅当方法只读或显式声明 safeToRetry 时回退，
   *    写操作抛出“结果未知”错误，提示用户刷新确认。
   */
  async call<TParams = any, TResult = any>(
    method: string,
    params?: TParams,
    options: RPC2CallOptions = {}
  ): Promise<TResult> {
    // 如果启用了自动连接，且当前未连接，尝试建立连接（不阻塞使用 HTTP 回退）
    if (this.options.autoConnect &&
        this.connectionState === RPC2ConnectionState.DISCONNECTED) {
      this.autoConnect();
    }

    const safeToRetry = options.safeToRetry ?? isReadOnlyRpcMethod(method);

    // 策略：
    // 1) WS 已连接 → 尝试 WS；按错误类型决定是否回退一次 HTTP
    // 2) 其他状态（未连/连接中/重连中/错误）→ 直接 HTTP
    if (this.connectionState === RPC2ConnectionState.CONNECTED) {
      try {
        return await this.callViaWebSocket(method, params, options);
      } catch (error) {
        if (error instanceof RPC2RequestNotSentError) {
          // 请求没有写入 socket，服务端不可能执行过，回退是安全的。
          return this.callViaHTTP(method, params, options);
        }
        if (error instanceof RPC2RequestUnknownError) {
          // 已经发送但没有拿到响应：只有只读/显式允许的方法才重试。
          if (safeToRetry) {
            return this.callViaHTTP(method, params, options);
          }
          throw error;
        }
        // 业务错误、协议错误以及未知异常：不重放
        throw error;
      }
    }

    // 未连或重连等情况下，直接使用 HTTP
    return this.callViaHTTP(method, params, options);
  }

  private getWebSocketUrl(): string {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const host = window.location.host;
    return `${protocol}//${host}${this.baseUrl}`;
  }

  private setupWebSocketHandlers(socket: WebSocket): void {
    socket.onopen = () => {
      if (this.ws !== socket) return;
      this.setConnectionState(RPC2ConnectionState.CONNECTED);
      if (this.stableConnectionTimeout) {
        clearTimeout(this.stableConnectionTimeout);
      }
      this.stableConnectionTimeout = setTimeout(() => {
        if (this.ws === socket && this.connectionState === RPC2ConnectionState.CONNECTED) {
          this.reconnectAttempts = 0;
        }
        this.stableConnectionTimeout = undefined;
      }, this.stableConnectionWindow);
      this.startHeartbeat(); // 启动心跳包
      this.eventListeners.onConnect?.();
    };

    socket.onmessage = (event) => {
      if (this.ws !== socket) return;
      try {
        const data = JSON.parse(event.data);
        this.handleMessage(data);
        this.eventListeners.onMessage?.(data);
      } catch (error) {
        console.error(i18n.t("rpc2.parse_websocket_message_failed"), error);
      }
    };

    socket.onclose = () => {
      if (this.ws !== socket) return;
      this.ws = null;
      this.setConnectionState(RPC2ConnectionState.DISCONNECTED);
      this.stopHeartbeat(); // 停止心跳包
      if (this.stableConnectionTimeout) {
        clearTimeout(this.stableConnectionTimeout);
        this.stableConnectionTimeout = undefined;
      }
      // 这些请求已经写入过 socket，结果未知，不能当作“未执行”。
      this.clearPendingRequests(this.createUnknownOutcomeError("connection_disconnected"));
      this.eventListeners.onDisconnect?.();

      if (!this.manualDisconnect && this.options.autoReconnect &&
          this.reconnectAttempts < this.options.maxReconnectAttempts) {
        this.attemptReconnect();
      }
    };

    socket.onerror = (error) => {
      if (this.ws !== socket) return;
      console.error(i18n.t("rpc2.websocket_error"), error);
      this.eventListeners.onError?.(
        new Error(i18n.t("rpc2.websocket_connection_error"))
      );
    };
  }

  private handleMessage(data: JSONRPC2Response): void {
    if (data.id === undefined || data.id === null) return; // 忽略通知响应

    const pending = this.pendingRequests.get(data.id);
    if (!pending) return;

    this.pendingRequests.delete(data.id);

    if (pending.timeout) {
      clearTimeout(pending.timeout);
    }

    if ("error" in data && data.error) {
      pending.reject(
        new RPC2BusinessError(data.error.code, data.error.message, data.error.data),
      );
    } else if ("result" in data) {
      pending.resolve(data.result);
    } else {
      pending.reject(
        new RPC2ProtocolError(
          i18n.t("rpc2.invalid_response", {
            defaultValue: "Malformed JSON-RPC response",
          }),
        ),
      );
    }
  }

  private sendMessage(message: JSONRPC2Request): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new RPC2RequestNotSentError(i18n.t("rpc2.websocket_not_connected"));
    }

    this.ws.send(JSON.stringify(message));
  }

  private toNotSentError(error: unknown): RPC2Error {
    if (error instanceof RPC2Error) return error;
    return new RPC2RequestNotSentError(
      error instanceof Error
        ? error.message
        : i18n.t("rpc2.websocket_not_connected"),
    );
  }

  private createUnknownOutcomeError(reasonKey: string): RPC2RequestUnknownError {
    return new RPC2RequestUnknownError(
      i18n.t(`rpc2.${reasonKey}`, {
        defaultValue:
          "The connection was interrupted after the request was sent; the result is unknown. Refresh to confirm before retrying.",
      }),
    );
  }

  private setConnectionState(state: RPC2ConnectionStateType): void {
    this.connectionState = state;
  }

  private generateRequestId(): number {
    return ++this.requestId;
  }

  private clearPendingRequests(error: Error): void {
    for (const [, pending] of this.pendingRequests) {
      if (pending.timeout) {
        clearTimeout(pending.timeout);
      }
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  /**
   * 启动心跳包
   */
  private startHeartbeat(): void {
    // 如果未启用心跳包，则不启动
    if (!this.options.enableHeartbeat) {
      return;
    }

    // 先清理之前的心跳包定时器
    this.stopHeartbeat();

    // 按配置的间隔发送心跳包
    this.heartbeatInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          // 发送心跳包作为通知请求（不期望响应）
          const heartbeatRequest: JSONRPC2Request = {
            jsonrpc: "2.0",
            method: "rpc.ping",
            params: { timestamp: Date.now() }
          };
          this.ws.send(JSON.stringify(heartbeatRequest));
        } catch (error) {
          console.warn(i18n.t("rpc2.send_heartbeat_failed"), error);
        }
      }
    }, this.options.heartbeatInterval);
  }

  /**
   * 停止心跳包
   */
  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
    }
  }

  private attemptReconnect(): void {
    if (this.reconnectTimeout || this.manualDisconnect) return;
    this.reconnectAttempts++;
    this.setConnectionState(RPC2ConnectionState.RECONNECTING);
    this.eventListeners.onReconnecting?.(this.reconnectAttempts);

    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = undefined;
      if (this.manualDisconnect) return;
      this.connect().catch(() => {
        // Failed handshakes are scheduled by connect() when no close event is emitted.
      });
    }, this.options.reconnectInterval);
  }
}

// 注意：避免在模块级别创建默认实例，以免在多处导入时重复建立 WebSocket 连接。
// 请通过 RPC2Provider + useRPC2Call/useRPC2 使用该客户端，或在需要的地方手动创建实例。
