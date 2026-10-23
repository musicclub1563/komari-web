import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Braces, Download, RotateCcw } from "lucide-react";
import { fetchOfficePreviewUrl, fileDownloadUrl } from "./fileManagerApi";
import {
  IDLE_OFFICE_PREVIEW,
  canStartOfficePreview,
  isOfficePreviewResultCurrent,
  type OfficePreviewState,
} from "./officePreview";

interface OfficeFilePreviewPanelProps {
  uuid: string;
  path: string;
}

/**
 * Office 文件面板。
 *
 * 默认不加载任何外部内容：既不申请预览令牌，也不渲染 iframe。
 * 只有用户点击“使用微软在线预览”后，才会申请一次性令牌并把带令牌的地址交给
 * view.officeapps.live.com（第三方）。直接下载始终可用。
 */
export default function OfficeFilePreviewPanel({ uuid, path }: OfficeFilePreviewPanelProps) {
  const { t } = useTranslation();
  const [preview, setPreview] = useState<OfficePreviewState>(IDLE_OFFICE_PREVIEW);
  const requestIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const previewPathRef = useRef<string | null>(path);
  previewPathRef.current = path;

  // 卸载时取消在途请求，避免关闭面板后过期结果回填。
  useEffect(
    () => () => {
      requestIdRef.current += 1;
      abortRef.current?.abort();
      abortRef.current = null;
    },
    [],
  );

  // 切换文件时清空状态，未确认的文件不会继承上一个文件的预览授权。
  useEffect(() => {
    requestIdRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setPreview(IDLE_OFFICE_PREVIEW);
  }, [path]);

  const startPreview = useCallback(async () => {
    if (!canStartOfficePreview({ open: true, kind: "office", path })) return;
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setPreview({ path, status: "loading", src: null, error: null });
    try {
      const src = await fetchOfficePreviewUrl(uuid, path, controller.signal);
      if (controller.signal.aborted) return;
      if (
        !isOfficePreviewResultCurrent(
          { requestId, path },
          { requestId: requestIdRef.current, path: previewPathRef.current },
        )
      ) {
        return;
      }
      setPreview({ path, status: "ready", src, error: null });
    } catch (error) {
      if (controller.signal.aborted) return;
      if (
        !isOfficePreviewResultCurrent(
          { requestId, path },
          { requestId: requestIdRef.current, path: previewPathRef.current },
        )
      ) {
        return;
      }
      setPreview({
        path,
        status: "error",
        src: null,
        error: error instanceof Error ? error.message : "Failed to create Office preview",
      });
    }
  }, [path, uuid]);

  if (preview.status === "ready" && preview.src && preview.path === path) {
    return (
      <iframe
        title={path}
        src={preview.src}
        referrerPolicy="no-referrer"
        data-office-preview="iframe"
        className="h-full w-full border-0 bg-white"
      />
    );
  }

  const loading = preview.status === "loading";
  const failed = preview.status === "error";

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 bg-[#1e1e1e] px-6 text-center text-xs text-[#a7a7a7]">
      <Braces size={36} strokeWidth={1.25} />
      <span className="text-sm">
        {t("file_manager.editor.office_preview_title", "Office 文档不在本地渲染")}
      </span>
      <p className="max-w-md leading-5">
        {t(
          "file_manager.editor.office_preview_notice",
          "使用微软在线预览会把该文件通过临时访问链接交给 Microsoft Office Online（第三方）在其服务器上打开。Komari 不会自动发起该请求。",
        )}
      </p>
      {failed && (
        <span data-office-preview="error" className="text-[#f48771]">
          {t("file_manager.editor.preview_failed", "Unable to preview this file")}
          {preview.error ? `: ${preview.error}` : ""}
        </span>
      )}
      <div className="flex flex-wrap items-center justify-center gap-3">
        <button
          type="button"
          data-office-preview="confirm"
          onClick={() => void startPreview()}
          disabled={loading}
          className="inline-flex items-center gap-1 rounded border border-[#555] bg-[#2d2d2d] px-3 py-1.5 text-xs text-white transition-colors hover:bg-[#3a3d41] disabled:opacity-50"
        >
          {loading && <RotateCcw size={14} className="animate-spin" />}
          {t("file_manager.editor.use_office_online", "使用微软在线预览")}
        </button>
        <a
          href={fileDownloadUrl(uuid, path)}
          data-office-preview="download"
          className="inline-flex items-center gap-1 rounded border border-[#555] px-3 py-1.5 text-xs text-[#75beff] transition-colors hover:bg-[#3a3d41]"
        >
          <Download size={14} />
          {t("file_manager.download", "Download")}
        </a>
      </div>
    </div>
  );
}
