import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Connection } from "../hooks/useWorkspace";
import { classNames } from "../utils";
import { IconClose, IconMaximize, IconMinus, IconRestore } from "./Icons";

interface Props {
  connection: Connection;
  /** 标题栏中部的说明文案，例如“12 个视频 · 已选 3” */
  note?: string;
  /** 右侧动作按钮（检查更新 / 刷新进度 / 运行日志） */
  children?: ReactNode;
}

/** 与 @tauri-apps/api 的 startResizeDragging 方向取值一致 */
type ResizeDirection = "East" | "North" | "NorthEast" | "NorthWest" | "South" | "SouthEast" | "SouthWest" | "West";

const CONNECTION_LABEL: Record<Connection, string> = {
  live: "实时同步",
  connecting: "正在连接",
  offline: "连接已断开",
};

/** 无边框窗口：四周留出 4px 拖拽热区手动触发缩放 */
const RESIZE_EDGES: Array<[ResizeDirection, string]> = [
  ["North", "n"],
  ["South", "s"],
  ["West", "w"],
  ["East", "e"],
  ["NorthWest", "nw"],
  ["NorthEast", "ne"],
  ["SouthWest", "sw"],
  ["SouthEast", "se"],
];

export default function TitleBar({ connection, note, children }: Props) {
  const inTauri = isTauri();
  const [maximized, setMaximized] = useState(false);
  const lastDown = useRef(0);

  useEffect(() => {
    if (!inTauri) return;
    const win = getCurrentWindow();
    let alive = true;
    let unlisten: (() => void) | undefined;
    const sync = () => {
      void win.isMaximized().then((value) => {
        if (alive) setMaximized(value);
      });
    };
    sync();
    void win.onResized(sync).then((off) => {
      if (alive) unlisten = off;
      else off();
    });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [inTauri]);

  // 空白处按住拖动窗口；双击最大化。按钮/输入框所在区域保持正常交互。
  const handleMouseDown = (event: ReactMouseEvent<HTMLElement>) => {
    if (event.button !== 0 || !inTauri) return;
    if ((event.target as HTMLElement).closest("button, a, input, [data-no-drag]")) return;
    const win = getCurrentWindow();
    const now = Date.now();
    if (now - lastDown.current < 320) {
      lastDown.current = 0;
      void win.toggleMaximize();
      return;
    }
    lastDown.current = now;
    void win.startDragging();
  };

  return (
    <header className="title-bar" onMouseDown={handleMouseDown}>
      <div className="title-brand">
        <img className="title-logo" src="/frog.png" alt="" />
        <strong className="title-text">智慧树助手</strong>
      </div>

      <span
        className={classNames("btn btn-quiet conn", connection)}
        title={CONNECTION_LABEL[connection]}
      >
        <i aria-hidden />
        {CONNECTION_LABEL[connection]}
      </span>

      <span className="title-note">{note}</span>

      {children && <div className="title-actions">{children}</div>}

      {inTauri && (
        <div className="win-controls" data-no-drag>
          <button
            className="win-btn"
            title="最小化"
            aria-label="最小化"
            onClick={() => void getCurrentWindow().minimize()}
          >
            <IconMinus size={15} />
          </button>
          <button
            className="win-btn"
            title={maximized ? "向下还原" : "最大化"}
            aria-label={maximized ? "向下还原" : "最大化"}
            onClick={() => void getCurrentWindow().toggleMaximize()}
          >
            {maximized ? <IconRestore size={14} /> : <IconMaximize size={13} />}
          </button>
          <button
            className="win-btn close"
            title="关闭"
            aria-label="关闭"
            onClick={() => void getCurrentWindow().close()}
          >
            <IconClose size={15} />
          </button>
        </div>
      )}

      {inTauri &&
        RESIZE_EDGES.map(([direction, edge]) => (
          <div
            key={direction}
            className={`win-resize ${edge}`}
            aria-hidden
            data-no-drag
            onMouseDown={(event) => {
              if (event.button !== 0) return;
              event.stopPropagation();
              void getCurrentWindow().startResizeDragging(direction);
            }}
          />
        ))}
    </header>
  );
}
