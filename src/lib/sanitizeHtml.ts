import DOMPurify from "dompurify";

/**
 * HTML 净化（DOMPurify + 明确白名单）。
 *
 * 管理端配置的页脚 HTML、主题/插件配置里的富文本说明，以及仓库内静态翻译文案
 * 都以 HTML 字符串形式存在。渲染前统一经过这里，使用经过维护的净化库和显式白名单，
 * 而不是正则黑名单：
 * - 只保留排版类标签，丢弃 script/style/iframe/svg/math/form 等可执行或外来内容；
 * - 只保留安全的 URL 协议，事件属性（on*）一律丢弃；
 * - 外链统一补 rel="noopener noreferrer"。
 *
 * 三个档位的权限从宽到窄：footer > translation > config。
 * 普通字段标题不要使用这里的宽档位，直接用 React 文本节点即可。
 */
export type HtmlProfile = "footer" | "translation" | "config";

const FORMATTING_TAGS = [
  "p",
  "br",
  "strong",
  "b",
  "em",
  "i",
  "u",
  "s",
  "span",
  "code",
  "small",
  "ul",
  "ol",
  "li",
];

const ALLOWED_TAGS: Record<HtmlProfile, string[]> = {
  // 页脚：管理员配置的富文本，保留分块、标题、图片与内联样式（原有能力）。
  footer: [
    ...FORMATTING_TAGS,
    "div",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "blockquote",
    "pre",
    "hr",
    "a",
    "img",
  ],
  // 静态翻译文案：只有排版与链接，没有图片、内联样式和分块容器。
  translation: [
    ...FORMATTING_TAGS,
    "h1",
    "h2",
    "h3",
    "h4",
    "label",
    "a",
    "blockquote",
  ],
  // 插件/主题配置的说明块：最窄，仅基础排版与链接。
  config: [...FORMATTING_TAGS, "h1", "h2", "h3", "h4", "a"],
};

const BASE_ATTRS = ["title", "class"];
const LINK_ATTRS = ["href", "target", "rel"];

const ALLOWED_ATTR: Record<HtmlProfile, string[]> = {
  footer: [
    ...BASE_ATTRS,
    ...LINK_ATTRS,
    "style",
    "src",
    "alt",
    "width",
    "height",
    "loading",
  ],
  translation: [...BASE_ATTRS, ...LINK_ATTRS],
  config: [...BASE_ATTRS, ...LINK_ATTRS],
};

const FORBID_TAGS = [
  "script",
  "style",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "link",
  "meta",
  "base",
  "form",
  "input",
  "button",
  "select",
  "textarea",
  "option",
  "template",
  "noscript",
  "svg",
  "math",
  "canvas",
  "video",
  "audio",
  "source",
  "track",
  "portal",
];

const FORBID_ATTR = [
  "srcdoc",
  "formaction",
  "action",
  "ping",
  "background",
  "poster",
  "xlink:href",
  "http-equiv",
];

/**
 * 危险协议：javascript:、vbscript:、以及用于携带可执行内容的 data:。
 * URL 的常规校验交给 DOMPurify 默认规则（它已阻止 javascript:/vbscript:，
 * 并允许相对路径）；这里额外把 data: 从 src/href 上一并移除。
 */
const DANGEROUS_PROTOCOL = /^(?:javascript|vbscript|data):/i;

/**
 * 浏览器解析 URL 时会忽略空白与控制字符（如 "java\tscript:"），
 * 因此先把它们全部剔除再判断协议，避免绕过。
 */
const normalizeUrlForProtocolCheck = (value: string) => {
  let normalized = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x20 || char.trim() === "") continue;
    normalized += char;
  }
  return normalized;
};

/** 内联样式里不允许出现可加载远程资源或脚本的写法。 */
const UNSAFE_STYLE = /(url\s*\(|expression\s*\(|javascript:|@import|behavior\s*:)/i;

const createPurifier = () => {
  if (typeof window === "undefined") return null;
  // 独立实例，避免影响其他库（如 monaco-editor）对默认实例的配置。
  const purifier = DOMPurify(window);
  purifier.addHook("afterSanitizeAttributes", (node) => {
    if (!(node instanceof Element)) return;
    for (const attribute of ["href", "src"]) {
      const value = node.getAttribute(attribute);
      if (value && DANGEROUS_PROTOCOL.test(normalizeUrlForProtocolCheck(value))) {
        node.removeAttribute(attribute);
      }
    }
    if (node.tagName === "A") {
      const target = node.getAttribute("target");
      if (target && target.toLowerCase() !== "_blank") {
        node.removeAttribute("target");
      }
      if (target && target.toLowerCase() === "_blank") {
        const rel = new Set(
          (node.getAttribute("rel") || "").toLowerCase().split(/\s+/).filter(Boolean),
        );
        rel.add("noopener");
        rel.add("noreferrer");
        node.setAttribute("rel", Array.from(rel).join(" "));
      }
    }
    const style = node.getAttribute("style");
    if (style && UNSAFE_STYLE.test(style)) {
      node.removeAttribute("style");
    }
  });
  return purifier;
};

let purifier: ReturnType<typeof createPurifier> | null | undefined;

/**
 * 净化 HTML 字符串。服务端渲染/无 DOM 环境直接返回空字符串（这些内容仅在浏览器渲染）。
 */
export const sanitizeHtml = (html: string, profile: HtmlProfile): string => {
  if (!html) return "";
  if (purifier === undefined) {
    purifier = createPurifier();
  }
  if (!purifier) return "";
  return purifier.sanitize(html, {
    ALLOWED_TAGS: ALLOWED_TAGS[profile],
    ALLOWED_ATTR: ALLOWED_ATTR[profile],
    FORBID_TAGS,
    FORBID_ATTR,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    KEEP_CONTENT: true,
    RETURN_TRUSTED_TYPE: false,
  }) as string;
};

/** 仅供测试/调试：导出各档位的白名单，便于审查权限边界。 */
export const HTML_PROFILES = { ALLOWED_TAGS, ALLOWED_ATTR } as const;
