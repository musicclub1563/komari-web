/* eslint-disable react-refresh/only-export-components -- 测试挂载页，不参与热更新 */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import InlineSvgIcon from "../src/components/InlineSvgIcon";

// 浏览器回归测试用的挂载页：只使用本地 fixtures，不访问外部站点。
const fixtures: Record<string, string> = {
  safe: "/script/fixtures/svg/safe.svg",
  script: "/script/fixtures/svg/script.svg",
  event: "/script/fixtures/svg/event.svg",
  foreign: "/script/fixtures/svg/foreign-object.svg",
  animate: "/script/fixtures/svg/animate-link.svg",
  control: "/script/fixtures/svg/control-protocol.svg",
  broken: "/script/fixtures/svg/broken.svg",
};

const params = new URLSearchParams(window.location.search);
const initialFixture = params.get("fixture") ?? "safe";

function Harness() {
  const [src, setSrc] = useState(fixtures[initialFixture] ?? fixtures.safe);
  const [visible, setVisible] = useState(true);

  const choose = (key: string) => () => setSrc(fixtures[key]);

  return (
    <div>
      <button id="set-safe" onClick={choose("safe")}>safe</button>
      <button id="set-script" onClick={choose("script")}>script</button>
      <button id="set-event" onClick={choose("event")}>event</button>
      <button id="set-foreign" onClick={choose("foreign")}>foreign</button>
      <button id="set-animate" onClick={choose("animate")}>animate</button>
      <button id="set-control" onClick={choose("control")}>control</button>
      <button id="set-broken" onClick={choose("broken")}>broken</button>
      <button
        id="set-javascript"
        onClick={() => setSrc("javascript:window.__pwned='javascript-src'")}
      >
        javascript
      </button>
      <button
        id="set-control-char-protocol"
        onClick={() => setSrc("java\nscript:window.__pwned='control-char-src'")}
      >
        control-char
      </button>
      <button
        id="set-oversize"
        onClick={() => setSrc(`data:image/svg+xml,${"A".repeat(70 * 1024)}`)}
      >
        oversize
      </button>
      <button id="toggle-visible" onClick={() => setVisible((value) => !value)}>toggle</button>
      <div id="host" style={{ width: 40, height: 40 }}>
        {visible ? (
          <InlineSvgIcon
            src={src}
            alt="fixture icon"
            className="harness-icon"
            style={{ width: 32, height: 32, objectFit: "contain" }}
          />
        ) : null}
      </div>
      <output id="current-src">{src.slice(0, 48)}</output>
    </div>
  );
}

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(<Harness />);
}
