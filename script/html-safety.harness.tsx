/* eslint-disable react-refresh/only-export-components -- 测试挂载页，不参与热更新 */
import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { useTranslation } from "react-i18next";
import { Theme } from "@radix-ui/themes";
import "@radix-ui/themes/styles.css";
import "../src/global.css";
import i18n from "../src/i18n/config";
import SafeHtml from "../src/components/SafeHtml";
import ConfigFormTabs, {
  type ConfigFormItem,
} from "../src/components/admin/ConfigFormTabs";
import { NodeListProvider } from "../src/contexts/NodeListContext";
import { RPC2Provider } from "../src/contexts/RPC2Context";
import { resolveI18nText, type I18nText } from "../src/utils/i18nText";

// 全部载荷只写 window.__pwned 标记，不读取 Cookie、不发起网络请求。
const MARK = (name: string) => `window.__pwned='${name}'`;

const ALLOWED_MARKUP = [
  '<p id="allow-p">License <b>MIT</b> · <a id="allow-link" href="https://example.test/privacy" target="_blank">Privacy</a><br>line two</p>',
  '<ul id="allow-list"><li>one</li><li>two</li></ul>',
].join("");

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

// 经典 mXSS / HTML 解析边界载荷。
const MXSS = [
  `<noscript><p title="</noscript><img id="mxss-1" src="x" onerror="${MARK("mxss1")}">">`,
  `<math><mtext><table><mglyph><style><img id="mxss-2" src="x" onerror="${MARK("mxss2")}">`,
  `<svg><p><style><img id="mxss-3" src="x" onerror="${MARK("mxss3")}">`,
  `<template><img id="mxss-4" src="x" onerror="${MARK("mxss4")}"></template>`,
].join("");

const FOOTER_HTML = `${ALLOWED_MARKUP}${PAYLOADS}${MXSS}`;
const TRANSLATION_HTML = `<h2 id="allow-h2">Heading</h2>${ALLOWED_MARKUP}${PAYLOADS}`;
const CONFIG_HTML = `<p id="allow-config">Tip <b>bold</b> <a id="allow-config-link" href="https://example.test/docs" target="_blank">docs</a></p>${PAYLOADS}`;

const NAME_PAYLOAD = `<img src=x onerror="${MARK("label")}">`;
const HELP_PAYLOAD = `<img src=x onerror="${MARK("help")}">`;

function RawControl() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // 对照组：与修复前的行为一致，直接把未净化 HTML 写入 DOM。
    if (ref.current) ref.current.innerHTML = FOOTER_HTML;
  }, []);
  return <div id="raw-control" ref={ref} />;
}

function TranslationSection() {
  const { t } = useTranslation();
  return (
    <div id="translation-safe">
      <div id="tips-cutpeak">
        <SafeHtml html={t("chart.cutPeak_tips")} />
      </div>
      <div id="tips-tags">
        <SafeHtml html={t("common.tagsTips")} />
      </div>
      <div id="tips-billing">
        <SafeHtml html={t("admin.nodeTable.billingCycleTips")} />
      </div>
      <div id="tips-offline">
        <SafeHtml html={t("notification.offline.tips")} />
      </div>
      <div id="payloads">
        <SafeHtml html={TRANSLATION_HTML} profile="translation" />
      </div>
    </div>
  );
}

function ConfigSection() {
  const { i18n: i18nInstance } = useTranslation();
  const [values, setValues] = useState<Record<string, unknown>>({
    "demo-switch": false,
  });
  const [events, setEvents] = useState<string[]>([]);

  useEffect(() => {
    (window as unknown as Record<string, unknown>).__configEvents = events;
  }, [events]);

  const items = useMemo<ConfigFormItem[]>(
    () => [
      { type: "textbox", name: CONFIG_HTML },
      {
        key: "demo-switch",
        type: "switch",
        name: { en: NAME_PAYLOAD, "zh-CN": NAME_PAYLOAD },
        help: { en: HELP_PAYLOAD, "zh-CN": HELP_PAYLOAD },
      },
      {
        key: "demo-text",
        type: "richtext",
        name: { en: "Only English", "zh-CN": "仅英文回落" },
        help: { en: "help only en" },
      },
    ],
    [],
  );

  const resolveText = (value?: I18nText) =>
    resolveI18nText(value, i18nInstance.language);

  return (
    <div id="config-form">
      <ConfigFormTabs
        items={items}
        values={values}
        onValueChange={(key, value) => {
          setEvents((current) => [...current, `${key}:${String(value)}`]);
          setValues((current) => ({ ...current, [key]: value }));
        }}
        resolveText={resolveText}
        header={<div>config header</div>}
        fillHeight={false}
      />
    </div>
  );
}

function Harness() {
  return (
    <Theme appearance="light">
      <div id="footer-safe">
        <SafeHtml html={FOOTER_HTML} profile="footer" />
      </div>
      <div id="config-safe">
        <SafeHtml html={CONFIG_HTML} profile="config" as="div" />
      </div>
      <TranslationSection />
      <RPC2Provider>
        <NodeListProvider>
          <ConfigSection />
        </NodeListProvider>
      </RPC2Provider>
      <RawControl />
    </Theme>
  );
}

(window as unknown as Record<string, unknown>).__setLanguage = (language: string) =>
  i18n.changeLanguage(language);

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(<Harness />);
}
