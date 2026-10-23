/**
 * Office 文档外部预览的状态与判定。
 *
 * 预览会把带临时下载令牌的 URL 交给 view.officeapps.live.com（第三方），
 * 因此只能由用户显式点击触发，并且状态必须与具体文件路径绑定：
 * 切换文件、关闭面板后，上一个文件的授权和异步结果都不能复用。
 */

export type OfficePreviewStatus = "idle" | "loading" | "ready" | "error";

export interface OfficePreviewState {
  /** 状态所属文件路径；空字符串表示当前没有任何外部预览。 */
  path: string;
  status: OfficePreviewStatus;
  /** 仅在用户确认并成功换取令牌后才有值。 */
  src: string | null;
  error: string | null;
}

export const IDLE_OFFICE_PREVIEW: OfficePreviewState = {
  path: "",
  status: "idle",
  src: null,
  error: null,
};

/** 取出与当前文件匹配的预览状态，其余情况一律视为未预览。 */
export const officePreviewFor = (
  state: OfficePreviewState,
  path: string | null | undefined,
): OfficePreviewState => (path && state.path === path ? state : IDLE_OFFICE_PREVIEW);

/** 是否允许（在用户点击后）为该文件申请外部预览令牌。 */
export const canStartOfficePreview = (input: {
  open: boolean;
  kind: string | undefined;
  path: string | null | undefined;
}): boolean => input.open && input.kind === "office" && Boolean(input.path);

/**
 * 异步结果是否仍然有效：请求序号与文件路径都必须与当前状态一致，
 * 否则丢弃（防止慢请求在切换文件后重新挂载旧预览）。
 */
export const isOfficePreviewResultCurrent = (
  result: { requestId: number; path: string },
  latest: { requestId: number; path: string | null },
): boolean => result.requestId === latest.requestId && latest.path === result.path;
