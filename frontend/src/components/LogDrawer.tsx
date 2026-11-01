import { useEffect, useMemo, useRef, useState } from "react";
import type { LogEntry } from "../types";
import { classNames } from "../utils";

interface Props {
  open: boolean;
  logs: LogEntry[];
  onClose: () => void;
}

export default function LogDrawer({ open, logs, onClose }: Props) {
  const [onlyKey, setOnlyKey] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const bodyRef = useRef<HTMLDivElement>(null);

  const visible = useMemo(() => {
    if (!onlyKey) return logs;
    return logs.filter((item) => item.level === "warn" || item.level === "error" || item.level === "success");
  }, [logs, onlyKey]);

  useEffect(() => {
    if (!open || !autoScroll) return;
    const node = bodyRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [logs, open, autoScroll]);

  return (
    <>
      {open && <div className="logs-mask" onClick={onClose} />}
      <aside className={classNames("logs", open && "open")} aria-label="运行日志" aria-hidden={!open}>
      <header className="logs-head">
        <div>
          <h2>运行日志</h2>
          <span>{logs.length} 条</span>
        </div>
        <button className="link-btn" onClick={onClose}>
          收起
        </button>
      </header>

      <div className="logs-tools">
        <label className="check-line">
          <input type="checkbox" checked={onlyKey} onChange={(event) => setOnlyKey(event.target.checked)} />
          <span>只看关键信息</span>
        </label>
        <label className="check-line">
          <input type="checkbox" checked={autoScroll} onChange={(event) => setAutoScroll(event.target.checked)} />
          <span>自动滚动</span>
        </label>
      </div>

      <div className="logs-body" ref={bodyRef}>
        {visible.length === 0 && <p className="logs-empty">还没有日志</p>}
        {visible.map((item, index) => (
          <div className={classNames("log-row", item.level)} key={`${item.ts}-${index}`}>
            <time>{item.time}</time>
            <p>{item.message}</p>
          </div>
        ))}
      </div>
    </aside>
    </>
  );
}
