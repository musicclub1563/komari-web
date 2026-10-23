import { useEffect, useState, type CSSProperties } from "react";
import { assessIconSource } from "@/lib/iconSource";

interface InlineSvgIconProps {
  src: string;
  alt: string;
  className?: string;
  style?: CSSProperties;
  loading?: "eager" | "lazy";
}

/**
 * 渲染插件 / 后台导航图标。
 *
 * 历史实现会抓取 SVG 文本、用正则黑名单清理后通过 dangerouslySetInnerHTML
 * 插入管理页面 DOM；黑名单漏掉 `<set>` / `<animate>` 等 SMIL 元素时，动画可以在
 * 清理之后把链接改写成 javascript: 并执行脚本。
 *
 * 现在一律通过 `<img>` 展示（名称保留以兼容既有调用方）：SVG 在图片上下文中
 * 不执行脚本、不绑定事件、也不参与页面 DOM，因此不需要在页面里“清理后内联”。
 * 仅做来源白名单（协议 / data: 载荷上限）与加载失败回退。
 */
export default function InlineSvgIcon({
  src,
  alt,
  className,
  style,
  loading,
}: InlineSvgIconProps) {
  const [failed, setFailed] = useState(false);
  const assessment = assessIconSource(src);

  useEffect(() => {
    setFailed(false);
  }, [src]);

  if (!assessment.allowed || failed) {
    return (
      <span
        className={className}
        style={{ display: "inline-flex", ...style }}
        role={alt ? "img" : undefined}
        aria-label={alt || undefined}
        aria-hidden={alt ? undefined : true}
        data-icon-state={assessment.allowed ? "error" : "blocked"}
      />
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      className={className}
      style={style}
      loading={loading}
      decoding="async"
      referrerPolicy="no-referrer"
      data-icon-state="image"
      onError={() => setFailed(true)}
    />
  );
}
