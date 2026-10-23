import assert from "node:assert/strict";

// OfficeFilePreviewPanel 的真实浏览器回归测试。
// 所有请求（预览令牌 + view.officeapps.live.com）都由 Playwright 拦截并返回
// 本地模拟数据，不会向微软发送任何文件信息或访问地址。
// 用法：先启动 dev server（npm run dev），再执行
//   node script/office-preview.browser.mjs

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({
  headless: true,
  ...(process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH } : {}),
});
const base = process.env.TEST_BASE_URL || "http://127.0.0.1:5173";

const tokenRequests = [];
const officeRequests = [];
const pageErrors = [];
let tokenDelayMs = 0;
let tokenFailure = null;

const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });

await context.route("**/api/**", async (route) => {
  const url = new URL(route.request().url());
  if (url.pathname.endsWith("/file/preview-token")) {
    tokenRequests.push(url.pathname + url.search);
    if (tokenDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, tokenDelayMs));
    }
    if (tokenFailure) {
      await route
        .fulfill({ status: tokenFailure.status, json: { message: tokenFailure.message } })
        .catch(() => undefined);
      return;
    }
    await route.fulfill({ json: { data: { token: "test-token" } } }).catch(() => undefined);
    return;
  }
  await route.fulfill({ json: {} }).catch(() => undefined);
});

await context.route("https://view.officeapps.live.com/**", async (route) => {
  officeRequests.push(route.request().url());
  await route
    .fulfill({ contentType: "text/html", body: "<html><body>mock office</body></html>" })
    .catch(() => undefined);
});

const page = await context.newPage();
page.on("pageerror", (error) => pageErrors.push(error.message));

const confirmButton = () => page.locator('[data-office-preview="confirm"]');
const iframe = () => page.locator('[data-office-preview="iframe"]');
const errorText = () => page.locator('[data-office-preview="error"]');

try {
  await page.goto(`${base}/script/office-preview.harness.html`, { waitUntil: "networkidle" });
  await confirmButton().waitFor({ timeout: 20000 });

  // 1. 打开文件时不得自动发起外部预览
  assert.equal(tokenRequests.length, 0, "opening an Office file must not request a preview token");
  assert.equal(await iframe().count(), 0, "no external iframe before consent");
  assert.equal(officeRequests.length, 0, "no request may be sent to the Office service before consent");
  const downloadHref = await page.locator('[data-office-preview="download"]').getAttribute("href");
  assert.ok(
    downloadHref && downloadHref.includes("path=%2Fdocs%2Freport.xlsx"),
    "direct download stays available",
  );
  console.log("PASS opening an Office file neither requests a token nor loads the external preview");

  // 2. 明确选择后才申请令牌并挂载 iframe
  await confirmButton().click();
  await iframe().waitFor({ timeout: 10000 });
  assert.equal(tokenRequests.length, 1, "exactly one token request after explicit consent");
  assert.ok(tokenRequests[0].includes("path=%2Fdocs%2Freport.xlsx"), "token request targets the open file");
  const src = await iframe().getAttribute("src");
  assert.ok(src && src.startsWith("https://view.officeapps.live.com/op/view.aspx?src="), "iframe points to Microsoft");
  const inner = decodeURIComponent(src.slice("https://view.officeapps.live.com/op/view.aspx?src=".length));
  assert.ok(inner.includes("preview_token=test-token"), "iframe carries the one-time token");
  const frame = page.frameLocator('[data-office-preview="iframe"]');
  await frame.locator("body").waitFor({ timeout: 10000 });
  assert.equal(await frame.locator("body").innerText(), "mock office", "iframe request was intercepted locally");
  console.log("PASS explicit consent requests exactly one token and mounts the external preview");

  // 3. 切换文件后不继承上一个文件的授权
  await page.click("#set-file-b");
  await confirmButton().waitFor();
  assert.equal(await iframe().count(), 0, "switching files must drop the external preview");
  assert.equal(tokenRequests.length, 1, "switching files must not request a token automatically");
  console.log("PASS switching files drops the previous authorization");

  // 4. 慢请求 + 切换文件：过期结果不能重新挂载旧预览
  tokenDelayMs = 1200;
  await page.click("#set-file-a");
  await confirmButton().click();
  await page.waitForTimeout(150);
  await page.click("#set-file-b");
  await page.waitForTimeout(1800);
  assert.equal(await iframe().count(), 0, "a late token response must not mount the old file preview");
  assert.equal(await page.locator('[data-office-preview="error"]').count(), 0, "cancelled request must not surface an error");
  assert.equal(tokenRequests.length, 2, "only the confirmed file requested a token");
  tokenDelayMs = 0;
  console.log("PASS a stale token response cannot remount a closed/switched preview");

  // 5. 失败时给出提示，且不加载 iframe
  tokenFailure = { status: 403, message: "preview disabled" };
  await confirmButton().click();
  await errorText().waitFor({ timeout: 10000 });
  assert.match(await errorText().innerText(), /preview disabled/);
  assert.equal(await iframe().count(), 0, "failed token exchange must not mount an iframe");
  tokenFailure = null;
  console.log("PASS token failures are reported without loading the external preview");

  // 6. 关闭面板后不残留 iframe
  await page.click("#set-file-a");
  await confirmButton().click();
  await iframe().waitFor({ timeout: 10000 });
  await page.click("#unmount");
  await page.waitForFunction(() => document.querySelectorAll('[data-office-preview="iframe"]').length === 0);
  console.log("PASS closing the panel removes the external preview");

  assert.deepEqual(pageErrors, [], "no uncaught page errors expected");
  console.log("PASS office preview browser regression suite");
} finally {
  await browser.close();
}
