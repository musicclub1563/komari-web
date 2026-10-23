/*
 * Legacy cache cleanup for the Komari PWA service worker.
 *
 * Earlier releases cached backend API responses (NetworkFirst + a shared
 * "api-cache" runtime cache) and replayed them when the network failed. That
 * included the login-state endpoint /api/me, so signing out and then going
 * offline could still expose the previous administrator's data.
 *
 * The current service worker never caches API responses, but installations that
 * already hold the old cache must be cleaned up. Only caches created by this
 * application are removed; caches of other applications on the same origin are
 * left untouched.
 */
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const legacyCacheNames = ["api-cache"];
      const names = await caches.keys();
      await Promise.all(
        names
          .filter(
            (name) =>
              legacyCacheNames.includes(name) || legacyCacheNames.some((n) => name.startsWith(`${n}-`)),
          )
          .map((name) => caches.delete(name)),
      );
    })(),
  );
});
