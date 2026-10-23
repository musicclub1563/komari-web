import assert from "node:assert/strict";

// 针对 InlineSvgIcon 的真实浏览器回归测试。
// 只加载仓库内 script/fixtures/svg 下的本地样例，样例中的“攻击”仅写入
// window.__pwned 标记，不发起任何网络请求，也不访问真实站点。
// 用法：先启动 dev server（npm run dev），再执行
//   node script/svg-icon.browser.mjs
// 可用 TEST_BASE_URL / PLAYWRIGHT_MODULE / BROWSER_PATH 覆盖默认值。

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({
  headless: true,
  ...(process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH } : {}),
});
const base = process.env.TEST_BASE_URL || "http://127.0.0.1:5173";

const pageErrors = [];
const requests = [];

const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
page.on("pageerror", (error) => pageErrors.push(error.message));
page.on("request", (request) => {
  requests.push({ url: request.url(), type: request.resourceType() });
});

const pwned = () => page.evaluate(() => window.__pwned ?? null);

const waitForImageLoaded = () =>
  page.waitForFunction(
    () => {
      const img = document.querySelector("#host img");
      return Boolean(img && img.complete && img.naturalWidth > 0);
    },
    undefined,
    { timeout: 15000 },
  );

const choose = async (id) => {
  await page.click(`#${id}`);
};

const assertInert = async (label) => {
  await page.waitForTimeout(700);
  assert.equal(await pwned(), null, `${label}: script must not execute`);
  assert.equal(await page.locator("#host script").count(), 0, `${label}: no script element may be injected`);
  assert.equal(await page.locator("#host foreignObject").count(), 0, `${label}: no foreignObject may be injected`);
  assert.equal(await page.locator("#host a").count(), 0, `${label}: no anchor may be injected`);
  assert.equal(await page.locator("#host svg").count(), 0, `${label}: markup must not be inlined into the page`);
};

try {
  await page.goto(`${base}/script/svg-icon.harness.html`, { waitUntil: "networkidle" });

  // 1. 普通安全 SVG 正常显示
  await waitForImageLoaded();
  assert.equal(await page.locator("#host img").count(), 1);
  const box = await page.locator("#host img").boundingBox();
  assert.ok(box && box.width > 0 && box.height > 0, "icon keeps its size/layout");
  console.log("PASS safe SVG renders through <img> with layout preserved");

  // 2. script / 事件属性 / foreignObject / 危险链接均被阻止
  await choose("set-script");
  await waitForImageLoaded();
  await assertInert("script.svg");
  await page.locator("#host img").click({ force: true });
  assert.equal(await pwned(), null, "script.svg: clicking the icon must not run code");
  console.log("PASS script, javascript: link and onload inside SVG stay inert");

  await choose("set-event");
  await waitForImageLoaded();
  await page.locator("#host img").hover();
  await page.locator("#host img").click({ force: true });
  await assertInert("event.svg");
  console.log("PASS event handler attributes inside SVG do not fire");

  await choose("set-foreign");
  await waitForImageLoaded();
  await assertInert("foreignObject.svg");
  console.log("PASS foreignObject content is not imported into the page");

  // 3. set/animate 改写链接的路径被阻止
  await choose("set-animate");
  await waitForImageLoaded();
  await page.waitForTimeout(1200);
  await assertInert("animate-link.svg");
  await page.locator("#host img").click({ force: true });
  assert.equal(await pwned(), null, "SMIL-driven javascript: link must not execute");
  console.log("PASS SMIL <set>/<animate> cannot execute javascript: URLs");

  // 4. 实体编码 / 控制字符协议
  await choose("set-control");
  await waitForImageLoaded();
  await page.locator("#host img").click({ force: true });
  await assertInert("control-protocol.svg");
  console.log("PASS entity-encoded and control-character protocols stay inert");

  // 组件自身的协议白名单
  await choose("set-javascript");
  await page.locator('#host [data-icon-state="blocked"]').waitFor({ timeout: 5000 });
  assert.equal(await page.locator("#host img").count(), 0, "javascript: src must not reach an <img>");
  await choose("set-control-char-protocol");
  await page.locator('#host [data-icon-state="blocked"]').waitFor({ timeout: 5000 });
  assert.equal(await page.locator("#host img").count(), 0, "control-char obfuscated scheme must be blocked");
  console.log("PASS javascript: / control-character sources are rejected before rendering");

  // 5. 超大 SVG 载荷上限
  await choose("set-oversize");
  await page.locator('#host [data-icon-state="blocked"]').waitFor({ timeout: 5000 });
  assert.equal(await page.locator("#host img").count(), 0, "oversized data: payload must be rejected");
  console.log("PASS oversized SVG payloads are rejected");

  // 6. 加载失败回退
  await choose("set-broken");
  await page.locator('#host [data-icon-state="error"]').waitFor({ timeout: 10000 });
  assert.equal(await page.locator("#host img").count(), 0, "broken icon falls back without a broken image");
  console.log("PASS failed icon load falls back gracefully");

  // 7. 切换 src / 卸载后不残留旧图标
  await choose("set-safe");
  await waitForImageLoaded();
  await choose("set-animate");
  await choose("set-script");
  await choose("set-safe");
  await waitForImageLoaded();
  assert.equal(await page.locator("#host img").count(), 1, "exactly one icon element must remain");
  const finalSrc = await page.locator("#host img").getAttribute("src");
  assert.ok(finalSrc && finalSrc.endsWith("/script/fixtures/svg/safe.svg"), "latest src wins");
  await choose("set-oversize");
  await choose("set-safe");
  await waitForImageLoaded();
  assert.equal(await page.locator("#host img").count(), 1);
  await page.click("#toggle-visible");
  await page.waitForFunction(() => document.querySelectorAll("#host img").length === 0);
  assert.equal(await pwned(), null);
  console.log("PASS switching src / unmounting never restores a stale icon");

  // 8. 组件不再读取 SVG 文本（只允许 image 请求）
  const svgRequests = requests.filter((request) => request.url.includes("/script/fixtures/svg/"));
  assert.ok(svgRequests.length > 0, "fixtures were requested");
  for (const request of svgRequests) {
    assert.equal(request.type, "image", `${request.url} must only be loaded as an image`);
  }
  console.log("PASS SVG files are only loaded as images, never fetched as text");

  assert.deepEqual(pageErrors, [], "no uncaught page errors expected");
  console.log("PASS svg icon browser regression suite");
} finally {
  await browser.close();
}
