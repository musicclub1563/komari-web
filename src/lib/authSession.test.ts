import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getAuthIdentity,
  notifyAuthIdentitySettled,
  resetAuthIdentityForTests,
  subscribeAuthIdentity,
  subscribeAuthIdentitySettled,
  syncAuthIdentity,
} from "./authSession";

afterEach(() => {
  resetAuthIdentityForTests();
});

describe("authSession identity tracking", () => {
  it("does not notify on the first sync or on unchanged identity", () => {
    const listener = vi.fn();
    subscribeAuthIdentity(listener);

    expect(syncAuthIdentity({ loggedIn: false, uuid: "" })).toBe(false);
    expect(syncAuthIdentity({ loggedIn: false, uuid: "" })).toBe(false);

    expect(listener).not.toHaveBeenCalled();
    expect(getAuthIdentity()).toEqual({ loggedIn: false, uuid: "" });
  });

  it("notifies once when a guest logs in", () => {
    const listener = vi.fn();
    subscribeAuthIdentity(listener);

    syncAuthIdentity({ loggedIn: false, uuid: "" });
    const changed = syncAuthIdentity({ loggedIn: true, uuid: "admin-uuid" });

    expect(changed).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(
      { loggedIn: true, uuid: "admin-uuid" },
      { loggedIn: false, uuid: "" },
    );
  });

  it("notifies again when the identity is cleared on logout", () => {
    const listener = vi.fn();
    subscribeAuthIdentity(listener);

    syncAuthIdentity({ loggedIn: true, uuid: "admin-uuid" });
    syncAuthIdentity({ loggedIn: false, uuid: "" });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][1]).toEqual({ loggedIn: true, uuid: "admin-uuid" });
  });

  it("stops notifying after unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeAuthIdentity(listener);

    syncAuthIdentity({ loggedIn: false, uuid: "" });
    unsubscribe();
    syncAuthIdentity({ loggedIn: true, uuid: "admin-uuid" });

    expect(listener).not.toHaveBeenCalled();
  });

  it("keeps notifying other listeners when one throws", () => {
    const failing = vi.fn(() => {
      throw new Error("boom");
    });
    const healthy = vi.fn();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    subscribeAuthIdentity(failing);
    subscribeAuthIdentity(healthy);

    syncAuthIdentity({ loggedIn: false, uuid: "" });
    syncAuthIdentity({ loggedIn: true, uuid: "admin-uuid" });

    expect(failing).toHaveBeenCalledTimes(1);
    expect(healthy).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });
});

describe("authSession settled phase", () => {
  it("notifies settled listeners so identity-dependent data can refresh", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeAuthIdentitySettled(listener);

    notifyAuthIdentitySettled();
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    notifyAuthIdentitySettled();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("clears listeners when reset for tests", () => {
    const identityListener = vi.fn();
    const settledListener = vi.fn();
    subscribeAuthIdentity(identityListener);
    subscribeAuthIdentitySettled(settledListener);

    resetAuthIdentityForTests();

    notifyAuthIdentitySettled();
    syncAuthIdentity({ loggedIn: false, uuid: "" });
    syncAuthIdentity({ loggedIn: true, uuid: "admin" });

    expect(identityListener).not.toHaveBeenCalled();
    expect(settledListener).not.toHaveBeenCalled();
    expect(getAuthIdentity()).toEqual({ loggedIn: true, uuid: "admin" });
  });
});
