/* eslint-disable react-refresh/only-export-components -- 测试挂载页，不参与热更新 */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import "../src/i18n/config";
import OfficeFilePreviewPanel from "../src/pages/terminal/OfficeFilePreviewPanel";

// 浏览器回归测试用的挂载页：所有网络请求都由测试脚本拦截，
// 不会访问真实的 Microsoft 服务或真实节点文件。
function Harness() {
  const [path, setPath] = useState("/docs/report.xlsx");
  const [visible, setVisible] = useState(true);

  return (
    <div>
      <button id="set-file-a" onClick={() => setPath("/docs/report.xlsx")}>file-a</button>
      <button id="set-file-b" onClick={() => setPath("/docs/budget.xlsx")}>file-b</button>
      <button id="unmount" onClick={() => setVisible((value) => !value)}>toggle</button>
      <div id="host" style={{ height: 360, width: 640 }}>
        {visible ? (
          <OfficeFilePreviewPanel key={path} uuid="node-1" path={path} />
        ) : null}
      </div>
    </div>
  );
}

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(<Harness />);
}
