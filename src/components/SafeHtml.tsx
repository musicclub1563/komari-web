import { useMemo, type CSSProperties } from "react";
import { sanitizeHtml, type HtmlProfile } from "@/lib/sanitizeHtml";

interface SafeHtmlProps {
  html?: string | null;
  /** footer > translation > config（权限由宽到窄） */
  profile?: HtmlProfile;
  className?: string;
  style?: CSSProperties;
  /** 默认 span，保持原有 DOM 结构；块级说明使用 div。 */
  as?: "span" | "div";
}

/**
 * 渲染不可信/外部来源的 HTML 片段。
 *
 * 这是应用内唯一允许把 HTML 字符串写入 DOM 的组件：内容先经过
 * `sanitizeHtml()`（DOMPurify + 显式白名单），再交给 React 渲染。
 * 普通文本请直接使用 React 文本节点，不要走这里。
 */
export default function SafeHtml({
  html,
  profile = "translation",
  className,
  style,
  as = "span",
}: SafeHtmlProps) {
  const clean = useMemo(() => sanitizeHtml(html ?? "", profile), [html, profile]);

  if (!clean) return null;

  const Tag = as;
  return (
    <Tag
      className={className}
      style={style}
      data-safe-html={profile}
      dangerouslySetInnerHTML={{ __html: clean }}
    />
  );
}
