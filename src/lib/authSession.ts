/**
 * 登录身份变化的轻量广播。
 *
 * 背景：RPC2Provider 使用全局单例 WebSocket 连接，Komari 服务端在握手时固定
 * 连接身份。SPA 内登录/退出登录只会更新 Cookie，旧的 WebSocket 连接仍是游客
 * 身份。因此任何身份变化都需要：
 *   1) 用最新 Cookie 重建 RPC 连接；
 *   2) 重新拉取依赖身份的数据（例如节点列表，游客看不到隐藏节点）。
 *
 * 这里用一个模块级订阅器把“身份变化”与 React 上下文解耦，避免
 * AccountContext 直接依赖 RPC2Context。
 */

export type AuthIdentity = {
  loggedIn: boolean;
  uuid: string;
};

export type AuthIdentityListener = (
  next: AuthIdentity,
  previous: AuthIdentity,
) => void;

let currentIdentity: AuthIdentity | null = null;
const listeners = new Set<AuthIdentityListener>();
const settledListeners = new Set<() => void>();

const normalize = (identity: AuthIdentity): AuthIdentity => ({
  loggedIn: identity.loggedIn === true,
  uuid: identity.uuid ?? "",
});

const isSameIdentity = (left: AuthIdentity, right: AuthIdentity) =>
  left.loggedIn === right.loggedIn && left.uuid === right.uuid;

/**
 * 记录最新的身份。仅当身份真正发生变化时才通知订阅者；
 * 首次记录（例如页面加载时）不会触发回调，因为连接本身就是用当前 Cookie 建立的。
 *
 * @returns 是否发生了身份变化
 */
export const syncAuthIdentity = (identity: AuthIdentity): boolean => {
  const next = normalize(identity);
  const previous = currentIdentity;
  currentIdentity = next;

  if (!previous || isSameIdentity(previous, next)) {
    return false;
  }

  for (const listener of Array.from(listeners)) {
    try {
      listener(next, previous);
    } catch (error) {
      console.error("[authSession] identity listener failed", error);
    }
  }
  return true;
};

/** 订阅身份变化，返回取消订阅函数。 */
export const subscribeAuthIdentity = (
  listener: AuthIdentityListener,
): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/**
 * 订阅“身份切换已落地”（RPC 连接已按新身份重建，或重建已失败结束）。
 *
 * 依赖身份的数据（例如节点列表）应在此阶段刷新，否则可能仍然走旧连接，
 * 拿到游客视角的数据。
 */
export const subscribeAuthIdentitySettled = (
  listener: () => void,
): (() => void) => {
  settledListeners.add(listener);
  return () => {
    settledListeners.delete(listener);
  };
};

/** 由 RPC 层在连接重建结束后调用。 */
export const notifyAuthIdentitySettled = (): void => {
  for (const listener of Array.from(settledListeners)) {
    try {
      listener();
    } catch (error) {
      console.error("[authSession] settled listener failed", error);
    }
  }
};

export const getAuthIdentity = (): AuthIdentity | null => currentIdentity;

/** 仅供测试使用：清空当前身份与订阅者。 */
export const resetAuthIdentityForTests = (): void => {
  currentIdentity = null;
  listeners.clear();
  settledListeners.clear();
};
