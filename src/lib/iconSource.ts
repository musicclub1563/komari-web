/**
 * 图标来源校验。
 *
 * 插件图标、后台导航图标来自上传的插件包或第三方 URL，属于不可信输入。
 * 现在这些图标统一通过 `<img>` 渲染，SVG 不再被插入管理页面 DOM，因此
 * SVG 内的脚本、事件处理器、SMIL 动画（set/animate）都无法执行；本模块只负责
 * 额外的协议白名单与体积上限，避免把明显危险的地址交给浏览器。
 */

/** 我们可以主动读入内存的 SVG 载荷上限（data: URL 形式）。 */
export const MAX_INLINE_SVG_BYTES = 64 * 1024;

// eslint-disable-next-line no-control-regex -- 语义就是要匹配控制字符，避免其混淆协议判定
const CONTROL_AND_WHITESPACE = /[\u0000-\u0020\u007f-\u009f]/g;
const SITE_RELATIVE = /^(?:\/(?!\/)|\.{1,2}\/)/;
const HTTP_URL = /^(?:https?:)?\/\//i;
const RASTER_DATA_URL = /^data:image\/(?:apng|avif|bmp|gif|jpe?g|png|webp)[;,]/i;
const SVG_DATA_URL = /^data:image\/svg\+xml[,;]/i;

const byteLength = (value: string): number => {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(value).byteLength;
  }
  return value.length;
};

/**
 * 去掉控制字符与空白后再判定，避免 `java\nscript:`、`\u0000javascript:` 这类
 * 变形绕过协议检查。
 */
export const normalizeIconSource = (src: string): string => src.replace(CONTROL_AND_WHITESPACE, "");

export type IconSourceRejection =
  | "empty"
  | "unsupported-protocol"
  | "too-large";

export interface IconSourceAssessment {
  allowed: boolean;
  normalized: string;
  rejection: IconSourceRejection | null;
}

/**
 * 判断图标地址是否允许交给 `<img src>`。
 *
 * 允许：站内相对路径（/x.svg、./x.svg、../x.svg）、http(s) 绝对地址、
 *      data: 位图（png/jpeg/gif/webp/...）以及未超出体积上限的 data:image/svg+xml。
 * 其他协议（javascript:、vbscript:、data:text/html 等）一律拒绝。
 */
export const assessIconSource = (src: string): IconSourceAssessment => {
  const normalized = normalizeIconSource(src ?? "");
  if (!normalized) {
    return { allowed: false, normalized, rejection: "empty" };
  }
  if (SITE_RELATIVE.test(normalized) || HTTP_URL.test(normalized)) {
    return { allowed: true, normalized, rejection: null };
  }
  if (SVG_DATA_URL.test(normalized)) {
    if (byteLength(normalized) > MAX_INLINE_SVG_BYTES) {
      return { allowed: false, normalized, rejection: "too-large" };
    }
    return { allowed: true, normalized, rejection: null };
  }
  if (RASTER_DATA_URL.test(normalized)) {
    return { allowed: true, normalized, rejection: null };
  }
  return { allowed: false, normalized, rejection: "unsupported-protocol" };
};

export const isAllowedIconSource = (src: string): boolean => assessIconSource(src).allowed;
