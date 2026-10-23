import assert from "node:assert/strict";

// HTML 净化回归测试：使用真实浏览器渲染真实组件，全部载荷只写 window.__pwned 标记，
// 不读取 Cookie、不发起网络请求、不访问真实站点。
// 用法：先启动 dev server（npm run dev），再执行
//   node script/html-safety.browser.mjs

import { pathToFileURL } from "node:url";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * PLAYWRIGHT_MODULE 允许指向 playwright / playwright-core 的绝对路径；
 * Windows 下 ESM 需要 file:// URL，且目录导入必须先解析到入口文件。
 */
const resolvePlaywrightModule = (specifier) => {
  if (!specifier.includes("\\") && !specifier.startsWith("/")) return specifier;
  const stat = statSync(specifier);
  if (!stat.isDirectory()) return pathToFileURL(specifier).href;
  const manifest = JSON.parse(readFileSync(path.join(specifier, "package.json"), "utf8"));
  return pathToFileURL(path.join(specifier, manifest.main || "index.js")).href;
};
// playwright-core 以 CJS 发布时命名导出可能拿不到，回退到 default。
const playwright = await import(
  resolvePlaywrightModule(process.env.PLAYWRIGHT_MODULE || "playwright")
);
const chromium = playwright.chromium ?? playwright.default?.chromium;
if (!chromium) throw new Error("Unable to load chromium from playwright module");
const browser = await chromium.launch({
  headless: true,
  ...(process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH } : {}),
});
const base = process.env.TEST_BASE_URL || "http://127.0.0.1:5173";
const harnessErrors = [];
const appErrors = [];

const MARK = (name) => `window.__pwned='${name}'`;
const PAYLOADS = [
  `<img id="bad-img" src="x" onerror="${MARK("img")}">`,
  `<script>${MARK("script")}</script>`,
  `<a id="bad-href" href="javascript:${MARK("href")}">bad link</a>`,
  `<a id="bad-entity" href="&#106;avascript:${MARK("entity")}">entity link</a>`,
  `<a id="bad-split-href" href="java&#9;script:${MARK("splithref")}">split scheme link</a>`,
  `<a id="bad-ctrl-href" href="&#31;javascript:${MARK("ctrlhref")}">ctrl scheme link</a>`,
  `<p id="bad-event" onclick="${MARK("click")}" onmouseover="${MARK("hover")}">clickable</p>`,
  `<iframe id="bad-frame" srcdoc="<script>parent.__pwned='frame'</script>"></iframe>`,
  `<svg id="bad-svg" onload="${MARK("svg")}"></svg>`,
  `<style>@import url("https://example.test/evil.css");</style>`,
  `<div id="bad-style-attr" style="background:url(javascript:${MARK("css")})">css</div>`,
].join("");

const inspect = (page, selector) =>
  page.evaluate((sel) => {
    const root = document.querySelector(sel);
    if (!root) return null;
    const all = Array.from(root.querySelectorAll("*"));
    return {
      tags: all.map((element) => element.tagName.toLowerCase()),
      withEventAttrs: all.filter((element) =>
        Array.from(element.attributes).some((attribute) => /^on/i.test(attribute.name)),
      ).length,
      jsHrefs: all.filter((element) => {
        // 浏览器会忽略 URL 中的空白与控制字符，检测时同样先规范化。
        const href = (element.getAttribute("href") || "").toLowerCase();
        const normalized = Array.from(href)
          .filter((char) => char.trim() !== "" && char.charCodeAt(0) > 0x20)
          .join("");
        return /^(?:javascript|vbscript|data):/.test(normalized);
      }).length,
      imgs: root.querySelectorAll("img").length,
      scripts: root.querySelectorAll("script").length,
      styles: root.querySelectorAll("style").length,
      iframes: root.querySelectorAll("iframe").length,
      svgs: root.querySelectorAll("svg").length,
      text: (root.textContent || "").trim(),
    };
  }, selector);

const assertInert = async (page, selector, label, { allowImages = false } = {}) => {
  const info = await inspect(page, selector);
  assert.ok(info, `${label}: container must render`);
  if (allowImages) {
    const unsafeImages = await page.evaluate((sel) => {
      const root = document.querySelector(sel);
      if (!root) return 0;
      return Array.from(root.querySelectorAll("img")).filter((image) => {
        const src = (image.getAttribute("src") || "").trim().toLowerCase();
        return src.startsWith("javascript:") || src.startsWith("data:");
      }).length;
    }, selector);
    assert.equal(unsafeImages, 0, `${label}: image URLs must stay on safe protocols`);
  } else {
    assert.equal(info.imgs, 0, `${label}: no <img> may survive`);
  }
  assert.equal(info.scripts, 0, `${label}: no <script> may survive`);
  assert.equal(info.styles, 0, `${label}: no <style> may survive`);
  assert.equal(info.iframes, 0, `${label}: no <iframe> may survive`);
  assert.equal(info.svgs, 0, `${label}: no <svg> may survive`);
  assert.equal(info.withEventAttrs, 0, `${label}: event handler attributes must be removed`);
  assert.equal(info.jsHrefs, 0, `${label}: javascript: URLs must be removed`);
  return info;
};

const pwned = (page) => page.evaluate(() => window.__pwned ?? null);
const resetPwned = (page) => page.evaluate(() => { window.__pwned = null; });

try {
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const page = await context.newPage();
  page.on("pageerror", (error) => harnessErrors.push(error.message));
  await page.goto(`${base}/script/html-safety.harness.html`, { waitUntil: "domcontentloaded" });

  // ---------------------------------------------------------------
  // 0. 对照组：同样的载荷直接写入 DOM 时必须执行（证明载荷有效）
  // ---------------------------------------------------------------
  await page.waitForFunction(
    () => Boolean(document.querySelector("#raw-control img")) && Boolean(window.__pwned),
    undefined,
    { timeout: 20000 },
  );
  console.log("PASS control: the raw payload executes when inserted without sanitising (pre-fix behaviour)");
  await resetPwned(page);

  // ---------------------------------------------------------------
  // 1. MEDIUM-1：页脚档位（footer profile）
  // ---------------------------------------------------------------
  await page.locator('#footer-safe [data-safe-html="footer"]').waitFor({ timeout: 20000 });
  // 页脚档位保留 <img>（原有排版能力），但事件属性与危险协议必须被清除。
  const footer = await assertInert(page, "#footer-safe", "footer", { allowImages: true });
  assert.ok(footer.tags.includes("p"), "footer: paragraphs must be preserved");
  assert.ok(footer.tags.includes("b"), "footer: bold text must be preserved");
  assert.ok(footer.tags.includes("br"), "footer: line breaks must be preserved");
  assert.ok(footer.tags.includes("ul") && footer.tags.includes("li"), "footer: lists must be preserved");

  // 注意：footer 档位不保留 id 属性（避免覆盖应用自身的 DOM id），因此按 href 定位。
  const link = await page.evaluate(() => {
    const anchor = document.querySelector('#footer-safe a[href="https://example.test/privacy"]');
    if (!anchor) return null;
    return {
      href: anchor.getAttribute("href"),
      target: anchor.getAttribute("target"),
      rel: anchor.getAttribute("rel") || "",
      text: anchor.textContent,
    };
  });
  assert.equal(link?.href, "https://example.test/privacy");
  assert.equal(link?.target, "_blank");
  assert.match(link?.rel ?? "", /noopener/);
  assert.match(link?.rel ?? "", /noreferrer/);
  assert.equal(link?.text, "Privacy");

  const unsafeStyles = await page.evaluate(() => {
    const root = document.querySelector("#footer-safe");
    if (!root) return 0;
    return Array.from(root.querySelectorAll("[style]")).filter((element) => {
      const style = (element.getAttribute("style") || "").toLowerCase();
      return style.includes("url(") || style.includes("javascript:") || style.includes("@import");
    }).length;
  });
  assert.equal(unsafeStyles, 0, "footer: style attributes with url()/javascript: must be dropped");

  const remainingAnchors = await page.locator("#footer-safe a").count();
  for (let index = 0; index < remainingAnchors; index += 1) {
    await page.locator("#footer-safe a").nth(index).click({ force: true }).catch(() => undefined);
  }
  assert.equal(await pwned(page), null, "footer: clicking sanitised links must not run code");
  console.log("PASS MEDIUM-1 footer profile keeps formatting/links and removes scripts, events, iframes, svg and dangerous URLs");

  // ---------------------------------------------------------------
  // 2. LOW-1：静态翻译文案 + translation 档位
  // ---------------------------------------------------------------
  await page.locator("#tips-cutpeak h2").waitFor({ timeout: 10000 });
  const cutPeak = await assertInert(page, "#tips-cutpeak", "cutPeak_tips");
  assert.ok(cutPeak.tags.includes("h2") && cutPeak.tags.includes("p"), "cutPeak_tips: headings/paragraphs preserved");
  assert.ok(cutPeak.tags.includes("strong"), "cutPeak_tips: emphasis preserved");
  assert.ok(cutPeak.text.includes("EWMA"), "cutPeak_tips: text content preserved");

  await assertInert(page, "#tips-billing", "billingCycleTips");
  assert.ok((await inspect(page, "#tips-billing")).tags.includes("br"), "billingCycleTips: line breaks preserved");

  await assertInert(page, "#tips-offline", "notification.offline.tips");
  const tagsTips = await assertInert(page, "#tips-tags", "tagsTips");
  assert.ok(tagsTips.tags.includes("a"), "tagsTips: documentation link preserved");
  const docsLink = await page.evaluate(() => {
    const anchor = document.querySelector("#tips-tags a");
    return anchor
      ? { href: anchor.getAttribute("href"), rel: anchor.getAttribute("rel") || "" }
      : null;
  });
  assert.ok(docsLink?.href?.startsWith("https://www.radix-ui.com/"), "tagsTips: link target preserved");
  assert.match(docsLink?.rel ?? "", /noopener/);

  await assertInert(page, "#payloads", "translation payloads");
  console.log("PASS LOW-1 static translations keep their formatting, links and interpolation while dropping executable markup");

  // ---------------------------------------------------------------
  // 3. MEDIUM-2：配置说明块与普通字段标题
  // ---------------------------------------------------------------
  await assertInert(page, '#config-safe [data-safe-html="config"]', "config profile");
  const configBlock = await inspect(page, '#config-safe [data-safe-html="config"]');
  assert.ok(configBlock.tags.includes("b"), "config: bold text preserved");
  const configLink = await page.evaluate(() => {
    const anchor = document.querySelector('#config-safe a[href="https://example.test/docs"]');
    return anchor ? { href: anchor.getAttribute("href"), rel: anchor.getAttribute("rel") || "" } : null;
  });
  assert.equal(configLink?.href, "https://example.test/docs");
  assert.match(configLink?.rel ?? "", /noopener/);

  const textbox = page.locator('#config-form [data-safe-html="config"]').first();
  await textbox.waitFor({ timeout: 10000 });
  await assertInert(page, '#config-form [data-safe-html="config"]', "config textbox");
  assert.ok((await inspect(page, '#config-form [data-safe-html="config"]')).tags.includes("b"));

  // 普通字段标题走 React 文本节点：载荷必须原样显示为文本，且不产生元素。
  await page.locator("#demo-switch").waitFor({ timeout: 10000 });
  const switchCard = await page.evaluate(() => {
    const card = document.querySelector("#demo-switch");
    if (!card) return null;
    return {
      text: (card.textContent || "").replace(/\s+/g, " ").trim(),
      imgs: card.querySelectorAll("img").length,
      scripts: card.querySelectorAll("script").length,
      eventAttrs: Array.from(card.querySelectorAll("*")).filter((element) =>
        Array.from(element.attributes).some((attribute) => /^on/i.test(attribute.name)),
      ).length,
    };
  });
  assert.ok(switchCard?.text.includes("<img src=x onerror="), "config field title must render the payload as text");
  assert.equal(switchCard?.imgs, 0, "config field title must not create an <img>");
  assert.equal(switchCard?.scripts, 0, "config field title must not create a <script>");
  assert.equal(switchCard?.eventAttrs, 0);

  // 交互仍然可用：开关切换会回传值。
  await page.locator('#demo-switch button[role="switch"]').click();
  await page.waitForFunction(
    () => Array.isArray(window.__configEvents) && window.__configEvents.some((event) => event.startsWith("demo-switch:")),
    undefined,
    { timeout: 10000 },
  );

  // 多语言与回退：zh-CN 有词条，en 有词条，ja-JP 回退到第一个可用值。
  const labelText = async (key) =>
    (await page.locator(`#${key}`).textContent())?.replace(/\s+/g, " ").trim() ?? "";
  await page.evaluate(() => window.__setLanguage("zh-CN"));
  await page.waitForFunction(() => document.querySelector("#demo-text")?.textContent?.includes("仅英文回落"), undefined, { timeout: 10000 });
  assert.ok((await labelText("demo-text")).includes("仅英文回落"), "zh-CN label rendered");
  await page.evaluate(() => window.__setLanguage("en"));
  await page.waitForFunction(() => document.querySelector("#demo-text")?.textContent?.includes("Only English"), undefined, { timeout: 10000 });
  await page.evaluate(() => window.__setLanguage("ja-JP"));
  await page.waitForFunction(() => document.querySelector("#demo-text")?.textContent?.includes("Only English"), undefined, { timeout: 10000 });
  const emptyName = await page.evaluate(() => document.querySelector("#demo-text")?.textContent?.length ?? 0);
  assert.ok(emptyName > 0, "missing translations fall back to an available value");
  console.log("PASS MEDIUM-2 config text blocks are sanitised, plain field titles stay escaped text, form interaction and language fallback still work");

  assert.equal(await pwned(page), null, "no payload may execute anywhere on the harness page");
  await context.close();
  assert.deepEqual(harnessErrors, [], "harness page must not raise uncaught errors");

  // ---------------------------------------------------------------
  // 4. 真实应用：/api/public 下发恶意 customFooterHtml
  // ---------------------------------------------------------------
  const appContext = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const appPage = await appContext.newPage();
  // 应用页会尝试连接不存在的 RPC WebSocket，仅记录、不作失败断言。
  appPage.on("pageerror", (error) => appErrors.push(error.message));

  await appPage.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/me") {
      await route.fulfill({ status: 401, json: { message: "unauthorized" } });
      return;
    }
    await route.fulfill({ json: { status: "success", data: {} } });
  });
  await appPage.route("**/api/public", async (route) => {
    await route.fulfill({
      json: {
        status: "success",
        data: {
          theme: "default",
          sitename: "komari-test",
          description: "test",
          theme_settings: {
            customFooterHtml: `<p id="footer-allow">Powered by <b>Komari</b> · <a id="footer-allow-link" href="https://example.test/tos" target="_blank">Terms</a></p>${PAYLOADS}`,
          },
        },
      },
    });
  });

  await appPage.goto(`${base}/`, { waitUntil: "domcontentloaded" });
  await appPage.locator('.km-footer [data-safe-html="footer"]').waitFor({ timeout: 30000 });

  const appFooter = await assertInert(appPage, '.km-footer [data-safe-html="footer"]', "app footer", { allowImages: true });
  assert.ok(appFooter.tags.includes("b"), "app footer: allowed formatting kept");
  const appLink = await appPage.evaluate(() => {
    const anchor = document.querySelector('.km-footer a[href="https://example.test/tos"]');
    return anchor ? { href: anchor.getAttribute("href"), rel: anchor.getAttribute("rel") || "" } : null;
  });
  assert.equal(appLink?.href, "https://example.test/tos");
  assert.match(appLink?.rel ?? "", /noopener/);
  assert.equal(await pwned(appPage), null, "app footer must not execute the configured payload");

  // 同一页面中直接写入未净化 HTML 仍然会执行：证明载荷有效、差异来自净化。
  await appPage.evaluate((html) => {
    const container = document.createElement("div");
    container.id = "raw-control-app";
    container.innerHTML = html;
    document.body.appendChild(container);
  }, `<img src="x" onerror="${MARK("control-app")}">`);
  await appPage.waitForFunction(() => window.__pwned === "control-app", undefined, { timeout: 10000 });
  console.log("PASS MEDIUM-1 real Footer sanitises the /api/public payload while the same markup executes raw");

  await appContext.close();

  if (appErrors.length > 0) {
    console.log(`INFO app page errors (expected without a backend): ${appErrors.slice(0, 3).join(" | ")}`);
  }
  console.log("PASS html sanitising browser regression suite");
} finally {
  await browser.close();
}
