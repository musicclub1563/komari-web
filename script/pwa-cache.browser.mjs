import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// 真实 Service Worker 回归测试：使用生产构建产物与浏览器实际运行的 Service Worker。
// 所有账号、Cookie、API 响应都由本脚本内置的本地服务器模拟，不访问任何真实服务器。
// 用法：node script/pwa-cache.browser.mjs
//   PLAYWRIGHT_MODULE / BROWSER_PATH 可覆盖浏览器驱动与内核路径。

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "komari-pwa-cache-"));

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

// 旧版本 Service Worker 的等价实现。
// 历史规则是 urlPattern: /^https:\/\/api\./i + NetworkFirst + cacheName "api-cache"，
// 即在以 "api." 开头的部署域名（包含本站自身的 /api/me）上缓存后端响应，
// 并在网络失败时回放这些响应。
const LEGACY_SW = `
const CACHE_NAME = "api-cache";
self.addEventListener("install", () => { self.skipWaiting(); });
self.addEventListener("activate", (event) => { event.waitUntil(self.clients.claim()); });
self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/")) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      const response = await fetch(request);
      if (response && response.status === 200) {
        await cache.put(request, response.clone());
      }
      return response;
    } catch (error) {
      const cached = await cache.match(request);
      if (cached) return cached;
      throw error;
    }
  })());
});
`;

const BOOT_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>boot</title></head><body>boot</body></html>`;

const parseCookies = (header) => {
  const out = {};
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    out[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return out;
};

function handleApi(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname === "/api/me") {
    const session = parseCookies(req.headers.cookie || "").komari_session;
    if (session === "adminA" || session === "adminB") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          username: session,
          role: "admin",
          private_data: `secret-of-${session}`,
        }),
      );
      return;
    }
    res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ message: "unauthorized" }));
    return;
  }
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({}));
}

function startServer({ root, basePath = "" }) {
  const server = http.createServer((req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname);
    } catch {
      pathname = "/";
    }

    // API 始终位于源站根路径（与 Komari 服务端一致）。
    if (pathname.startsWith("/api/")) {
      handleApi(req, res);
      return;
    }
    if (pathname === "/old-sw.js") {
      res.writeHead(200, {
        "Content-Type": "text/javascript; charset=utf-8",
        "Cache-Control": "no-store",
        "Service-Worker-Allowed": "/",
      });
      res.end(LEGACY_SW);
      return;
    }
    if (pathname === "/boot.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(BOOT_HTML);
      return;
    }

    if (basePath) {
      if (pathname === basePath) pathname = "/";
      else if (pathname.startsWith(`${basePath}/`)) pathname = pathname.slice(basePath.length);
      else {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("not found");
        return;
      }
    }

    const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const file = path.resolve(root, relative);
    if (!file.startsWith(path.resolve(root)) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    fs.createReadStream(file).pipe(res);
  });
  server.on("upgrade", (request, socket) => socket.destroy());
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function runBuild(outDir, baseUrl) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(repoRoot, "node_modules", "vite", "bin", "vite.js"), "build", "--outDir", outDir, "--emptyOutDir"],
      {
        cwd: repoRoot,
        env: { ...process.env, VITE_BASE_URL: baseUrl, NODE_ENV: "production" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";
    child.stdout.on("data", () => undefined);
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`vite build failed (${code}): ${stderr.slice(-800)}`));
    });
  });
}

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({
  headless: true,
  ...(process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH } : {}),
});

const fetchMe = async (page) =>
  page.evaluate(async () => {
    try {
      // 绕过 HTTP 缓存，只观察 Service Worker 的缓存行为。
      const response = await fetch("/api/me", { cache: "no-store" });
      return { ok: true, status: response.status, body: await response.text() };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  });

const cacheNames = (page) => page.evaluate(() => caches.keys());

const cachedApiEntries = (page) =>
  page.evaluate(async () => {
    const hits = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) {
        if (new URL(request.url).pathname.startsWith("/api/")) hits.push(request.url);
      }
    }
    return hits;
  });

const cacheBodies = (page) =>
  page.evaluate(async () => {
    const bodies = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) {
        const response = await cache.match(request);
        bodies.push(`${request.url} => ${response ? (await response.text()).slice(0, 120) : ""}`);
      }
    }
    return bodies;
  });

const waitFor = async (predicate, { timeout = 20000, interval = 200, label = "condition" } = {}) => {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`timeout waiting for ${label} (last value: ${JSON.stringify(last)})`);
};

const openServers = [];
const startServerTracked = async (options) => {
  const handle = await startServer(options);
  openServers.push(handle.server);
  return handle;
};

try {
  console.log("building production bundles for root and sub path deployments...");
  const rootDist = path.join(workDir, "root");
  const subDist = path.join(workDir, "sub");
  await runBuild(rootDist, "/");
  await runBuild(subDist, "/komari/");

  const rootServer = await startServerTracked({ root: rootDist });
  const subServer = await startServerTracked({ root: subDist, basePath: "/komari" });
  const rootOrigin = `http://127.0.0.1:${rootServer.port}`;
  const subOrigin = `http://127.0.0.1:${subServer.port}`;
  // 旧规则的 urlPattern 只匹配以 "api." 开头的部署域名，这里使用同样的域名形状。
  const apiHostOrigin = `http://api.localhost:${rootServer.port}`;

  const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  const page = await context.newPage();

  // ---------------------------------------------------------------------
  // 1. 旧 Service Worker 的问题复现：登录态响应被缓存，退出后离线仍返回旧数据
  // ---------------------------------------------------------------------
  await page.goto(`${apiHostOrigin}/boot.html`, { waitUntil: "domcontentloaded" });
  await page.evaluate(async () => {
    await navigator.serviceWorker.register("/old-sw.js", { scope: "/" });
    await navigator.serviceWorker.ready;
  });
  await context.addCookies([{ name: "komari_session", value: "adminA", url: apiHostOrigin }]);

  const loggedIn = await fetchMe(page);
  assert.equal(loggedIn.ok, true, "logged-in request must succeed");
  assert.equal(loggedIn.status, 200);
  assert.match(loggedIn.body, /adminA/);

  const legacyCaches = await cacheNames(page);
  assert.ok(legacyCaches.includes("api-cache"), "legacy service worker cached the API response");

  // 退出登录：清除 Cookie 后在线请求返回 401。
  await context.clearCookies();
  const afterLogout = await fetchMe(page);
  assert.equal(afterLogout.status, 401, "logged-out request must be rejected by the server");

  // 网络失败：旧规则会回放缓存中的管理员响应（本次要修复的行为）。
  await context.setOffline(true);
  const staleOffline = await fetchMe(page);
  assert.equal(staleOffline.ok, true, "legacy behaviour: offline still answered from the cache");
  assert.match(staleOffline.body, /adminA/, "legacy behaviour: stale administrator payload was replayed");
  await context.setOffline(false);
  console.log("PASS reproduced the legacy bug: logout + offline still returned the cached admin payload");

  // 无关应用的缓存必须保留。
  await page.evaluate(async () => {
    const cache = await caches.open("other-app-cache");
    await cache.put("/other-app/data", new Response("keep-me"));
  });

  // ---------------------------------------------------------------------
  // 2. 升级到新 Service Worker：旧敏感缓存被清理，多标签页被接管
  // ---------------------------------------------------------------------
  const appTab = await context.newPage();
  await appTab.goto(`${apiHostOrigin}/`, { waitUntil: "domcontentloaded" });
  await appTab.waitForFunction(
    () =>
      navigator.serviceWorker.controller &&
      navigator.serviceWorker.controller.scriptURL.includes("/sw.js"),
    undefined,
    { timeout: 30000 },
  );
  await waitFor(
    async () => !(await cacheNames(appTab)).includes("api-cache"),
    { label: "legacy api-cache removal" },
  );

  const afterUpgrade = await cacheNames(appTab);
  assert.ok(!afterUpgrade.includes("api-cache"), "legacy api-cache must be purged on activation");
  assert.ok(afterUpgrade.includes("other-app-cache"), "caches of other applications must be preserved");
  assert.deepEqual(await cachedApiEntries(appTab), [], "no /api/ response may remain in any cache");
  console.log("PASS new service worker purges the legacy api-cache and keeps unrelated caches");

  // 旧标签页也会被接管（clientsClaim）。
  await waitFor(
    async () => {
      const controller = await page.evaluate(
        () => navigator.serviceWorker.controller?.scriptURL || "",
      );
      return controller.includes("/sw.js");
    },
    { label: "old tab takeover" },
  );

  // 升级后离线不得回放旧的私有数据。
  await context.setOffline(true);
  const offlineAfterUpgrade = await fetchMe(page);
  assert.equal(offlineAfterUpgrade.ok, false, "offline request must fail instead of serving cached data");
  const offlineInAppTab = await fetchMe(appTab);
  assert.equal(offlineInAppTab.ok, false, "offline request in the new tab must fail as well");
  await context.setOffline(false);
  console.log("PASS after the upgrade, offline requests fail instead of replaying private data");

  // ---------------------------------------------------------------------
  // 3. 在线 401 之后再离线，不得回退到旧的 200
  // ---------------------------------------------------------------------
  const unauthorized = await fetchMe(page);
  assert.equal(unauthorized.status, 401);
  await context.setOffline(true);
  const after401Offline = await fetchMe(page);
  assert.equal(after401Offline.ok, false, "a previous 401 must not be replaced by a cached 200");
  await context.setOffline(false);
  console.log("PASS a 401 response is not replaced by an older cached 200 when the network fails");

  // ---------------------------------------------------------------------
  // 4. 用户 A 切换到用户 B：不得复用 A 的响应
  // ---------------------------------------------------------------------
  await context.addCookies([{ name: "komari_session", value: "adminA", url: apiHostOrigin }]);
  const userA = await fetchMe(page);
  assert.match(userA.body, /adminA/);
  await context.addCookies([{ name: "komari_session", value: "adminB", url: apiHostOrigin }]);
  const userB = await fetchMe(page);
  assert.match(userB.body, /adminB/);
  await context.setOffline(true);
  const offlineAfterSwitch = await fetchMe(page);
  assert.equal(offlineAfterSwitch.ok, false, "offline must not replay another user's payload");
  await context.setOffline(false);
  const cachedBodies = await cacheBodies(page);
  assert.ok(
    !cachedBodies.some((entry) => entry.includes("secret-of-adminA") || entry.includes("secret-of-adminB")),
    "no private payload may be stored in any cache",
  );
  console.log("PASS switching users never reuses the previous user's cached response");

  // ---------------------------------------------------------------------
  // 5. 静态资源缓存仍然有效（离线可读取预缓存资源）
  // ---------------------------------------------------------------------
  const precachedAsset = await appTab.evaluate(async () => {
    for (const name of await caches.keys()) {
      if (!name.startsWith("workbox-precache")) continue;
      const cache = await caches.open(name);
      for (const request of await cache.keys()) {
        if (new URL(request.url).pathname.includes("/assets/")) return request.url;
      }
    }
    return null;
  });
  assert.ok(precachedAsset, "static assets must be precached");
  await context.setOffline(true);
  const offlineAsset = await appTab.evaluate(async (url) => {
    const response = await fetch(url, { cache: "no-store" });
    return { ok: response.ok, length: (await response.text()).length };
  }, precachedAsset);
  assert.equal(offlineAsset.ok, true, "precached static assets must still be served offline");
  assert.ok(offlineAsset.length > 0);
  await context.setOffline(false);
  console.log("PASS immutable static assets are still cached and served offline");

  // ---------------------------------------------------------------------
  // 6. 不再缓存通配的外部 api.* 域名
  // ---------------------------------------------------------------------
  const swSource = fs.readFileSync(path.join(rootDist, "sw.js"), "utf8");
  assert.ok(!swSource.includes("api-cache"), "the new worker must not reference the legacy cache");
  assert.ok(!swSource.includes("NetworkFirst"), "the new worker must not use NetworkFirst");
  assert.ok(swSource.includes("NetworkOnly"), "the new worker must use NetworkOnly for the API");
  assert.deepEqual(await cachedApiEntries(appTab), []);
  console.log("PASS the generated worker neither caches api.* domains nor keeps API responses");

  await context.close();

  // ---------------------------------------------------------------------
  // 7. 子路径部署（/komari/）
  // ---------------------------------------------------------------------
  const subContext = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  const subPage = await subContext.newPage();
  await subPage.goto(`${subOrigin}/komari/`, { waitUntil: "domcontentloaded" });
  await subPage.waitForFunction(
    () =>
      navigator.serviceWorker.controller &&
      navigator.serviceWorker.controller.scriptURL.includes("/komari/sw.js"),
    undefined,
    { timeout: 30000 },
  );
  await subContext.addCookies([
    { name: "komari_session", value: "adminA", url: subOrigin },
  ]);
  const subLoggedIn = await fetchMe(subPage);
  assert.equal(subLoggedIn.status, 200, "sub path deployment must still reach the API");
  await subContext.clearCookies();
  const subUnauthorized = await fetchMe(subPage);
  assert.equal(subUnauthorized.status, 401);
  await subContext.setOffline(true);
  const subOffline = await fetchMe(subPage);
  assert.equal(subOffline.ok, false, "sub path deployment must not replay cached API data offline");
  await subContext.setOffline(false);
  assert.deepEqual(await cachedApiEntries(subPage), []);
  const subPrecached = await subPage.evaluate(async () => {
    for (const name of await caches.keys()) {
      if (!name.startsWith("workbox-precache")) continue;
      const cache = await caches.open(name);
      for (const request of await cache.keys()) {
        if (new URL(request.url).pathname.includes("/komari/assets/")) return request.url;
      }
    }
    return null;
  });
  assert.ok(subPrecached, "sub path deployment must precache its assets");
  console.log("PASS sub path deployment keeps the API uncached and still caches static assets");

  await subContext.close();

  console.log("PASS pwa cache browser regression suite");
} finally {
  await browser.close();
  for (const server of openServers) {
    await new Promise((resolve) => server.close(resolve));
  }
  try {
    fs.rmSync(workDir, { recursive: true, force: true });
  } catch {
    // 某些环境禁止批量删除，遗留的临时目录不影响仓库内容。
  }
}
