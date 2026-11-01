import React from "react";

/**
 * React 渲染异常不会走 window.onerror（React 会自己吞掉并卸载整棵树），
 * 没有边界的话用户看到的就是纯白屏。
 */

type Props = { children: React.ReactNode };
type State = { message: string };

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { message: "" };

  static getDerivedStateFromError(error: Error): State {
    return { message: error.message || "界面渲染失败" };
  }

  render(): React.ReactNode {
    if (!this.state.message) {
      return this.props.children;
    }
    return (
      <div style={wrapStyle}>
        <h2 style={{ margin: "0 0 8px", fontSize: 18 }}>界面出错了</h2>
        <p style={{ margin: "0 0 16px", fontSize: 13, opacity: 0.7, wordBreak: "break-all" }}>
          {this.state.message}
        </p>
        <p style={{ margin: "0 0 16px", fontSize: 12, opacity: 0.5 }}>
          重新加载即可继续使用。
        </p>
        <button type="button" style={buttonStyle} onClick={() => window.location.reload()}>
          重新加载
        </button>
      </div>
    );
  }
}

const wrapStyle: React.CSSProperties = {
  minHeight: "100vh",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  padding: 24,
  textAlign: "center",
  fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
};

const buttonStyle: React.CSSProperties = {
  padding: "8px 20px",
  borderRadius: 8,
  border: "1px solid rgba(127,127,127,0.4)",
  background: "transparent",
  color: "inherit",
  cursor: "pointer",
  fontSize: 13,
};
