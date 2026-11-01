import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { CaptchaPayload } from "../types";
import { clamp } from "../utils";
import { IconRefresh, IconSparkle, IconCheck } from "./Icons";

interface Props {
  payload: CaptchaPayload;
  notice?: string;
  onSolved: () => void;
  onCancel: () => void;
}

/** 滑块按钮宽度，必须与 styles.css 中 .captcha-handle 的 width 一致 */
const HANDLE_W = 40;

export default function CaptchaModal({ payload, notice, onSolved, onCancel }: Props) {
  const [data, setData] = useState<CaptchaPayload>(payload);
  const [ratio, setRatio] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(notice || "拖动滑块，让拼图与缺口对齐");
  const [failed, setFailed] = useState(false);
  const trackRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setData(payload);
    setRatio(0);
  }, [payload]);

  const updateFromX = useCallback((clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect) return;
    const usable = Math.max(1, rect.width - HANDLE_W);
    const pct = ((clientX - rect.left - HANDLE_W / 2) / usable) * 100;
    setRatio(clamp(pct, 0, 100));
  }, []);

  useEffect(() => {
    if (!dragging) return;
    const move = (event: PointerEvent) => updateFromX(event.clientX);
    const up = () => setDragging(false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [dragging, updateFromX]);

  const submit = async (value: number) => {
    setBusy(true);
    setFailed(false);
    setMessage("正在校验…");
    try {
      const result = await api.captchaSubmit(value);
      if (result.ok) {
        setMessage(result.message);
        onSolved();
        return;
      }
      setFailed(true);
      setMessage(result.message);
      setRatio(0);
      if (result.expired) {
        window.setTimeout(onCancel, 1500);
        return;
      }
      if (result.captcha) setData(result.captcha);
    } catch (error) {
      setFailed(true);
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const autoSolve = async () => {
    setBusy(true);
    setFailed(false);
    setMessage("正在识别缺口…");
    try {
      const solved = await api.captchaSolve();
      if (solved.ratio === null) {
        setFailed(true);
        setMessage(solved.message);
        if (solved.expired) window.setTimeout(onCancel, 1500);
        return;
      }
      setRatio(solved.ratio);
      setMessage(`已识别缺口（${solved.method}），正在提交…`);
      await submit(solved.ratio);
    } catch (error) {
      setFailed(true);
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const refresh = async () => {
    setBusy(true);
    setFailed(false);
    setMessage("正在刷新验证码…");
    try {
      setData(await api.captchaNew());
      setRatio(0);
      setMessage("拖动滑块，让拼图与缺口对齐");
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const piecePct = (data.piece_width / Math.max(1, data.width)) * 100;
  // 与原项目 main.py 保持一致：滑块比例 = 拼图左边缘占背景图宽度的百分比，
  // 这样用户目视对齐缺口时，提交的数值就是正确比例。
  const leftPct = clamp(ratio, 0, 100);

  return (
    <div className="modal-mask">
      <div className="captcha-card">
        <div className="captcha-head">
          <div>
            <h3>安全验证</h3>
            <p>网易易盾滑块验证，首次登录或会话过期时需要</p>
          </div>
          <button className="link-btn" onClick={onCancel}>
            关闭
          </button>
        </div>

        <div className="captcha-stage" style={{ aspectRatio: `${data.width} / ${data.height}` }}>
          <img src={data.background} alt="验证码背景" draggable={false} />
          <img
            className="captcha-piece"
            src={data.piece}
            alt="拼图"
            draggable={false}
            style={{ left: `${leftPct}%`, width: `${piecePct}%` }}
          />
        </div>

        <div className={`captcha-track${dragging ? " dragging" : ""}`} ref={trackRef}>
          <div className="captcha-track-fill" style={{ width: `${ratio}%` }} />
          <div
            className="captcha-handle"
            style={{ left: `calc(${ratio}% - ${(ratio / 100) * HANDLE_W}px)` }}
            onPointerDown={(event) => {
              if (busy) return;
              event.preventDefault();
              setDragging(true);
              updateFromX(event.clientX);
            }}
          >
            {busy ? <span className="spinner small" /> : <IconCheck size={18} />}
          </div>
          <span className="captcha-hint">向右拖动完成拼图</span>
        </div>

        <p className={`captcha-message${failed ? " error" : ""}`}>{message}</p>

        <div className="captcha-actions">
          <button className="btn btn-quiet" onClick={refresh} disabled={busy}>
            <IconRefresh size={15} />
            换一张
          </button>
          <button className="btn btn-quiet" onClick={autoSolve} disabled={busy}>
            <IconSparkle size={15} />
            自动识别
          </button>
          <button className="btn btn-primary" onClick={() => submit(ratio)} disabled={busy || ratio <= 0}>
            提交验证
          </button>
        </div>
      </div>
    </div>
  );
}
