import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import type { StudyCaptchaAuto, StudyCaptchaPayload, StudyCaptchaSubmitResult } from "../types";
import { IconCheck, IconRefresh } from "./Icons";

interface Props {
  payload: StudyCaptchaPayload;
  task?: { id?: string; name?: string };
  onSubmit: (points: number[][], trace: number[][]) => Promise<StudyCaptchaSubmitResult>;
  onRefresh: () => Promise<StudyCaptchaPayload>;
  /** 收起到角落，不阻塞主界面操作 */
  onDismiss?: () => void;
  /** 用户已在浏览器手工完成，通知后端重试 */
  onRetry?: () => Promise<{ ok: boolean; message: string }>;
  /** 自动识别进度；null 表示没在自动跑 */
  auto?: StudyCaptchaAuto | null;
  /** 用户要自己点：停掉自动识别 */
  onAutoStop?: () => Promise<{ ok: boolean; message: string }>;
}

type Phase = "idle" | "busy" | "error" | "ok";

/**
 * 学习页人机验证（易盾空间推理）。
 *
 * 平台在进度上报时返回 -12，后端拉一张图推过来，用户按中文提示点一个目标字符。
 * 只保留最后一次点击的位置：点别处会覆盖上一个点，避免多次点击把数据弄乱。
 */
export default function StudyCaptchaModal({
  payload,
  task,
  onSubmit,
  onRefresh,
  onDismiss,
  onRetry,
  auto,
  onAutoStop,
}: Props) {
  const [data, setData] = useState<StudyCaptchaPayload>(payload);
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState("点击图片上的目标字符");
  const [loaded, setLoaded] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  // 图片显示时刻与真实鼠标轨迹：提交时一起发给后端，
  // 风控会看点击时间偏移和轨迹，全发 0/空很容易被判假
  const shownAt = useRef(0);
  const trail = useRef<number[][]>([]);
  const lastMoveAt = useRef(0);

  useEffect(() => {
    setData(payload);
    setPoint(null);
    setPhase("idle");
    setMessage("点击图片上的目标字符");
    // 换图：重置计时与轨迹，避免把上一张图的轨迹带到新图上
    shownAt.current = 0;
    trail.current = [];
    lastMoveAt.current = 0;
  }, [payload]);

  /** 鼠标在图上移动：按 40ms 采样记轨迹，上限 40 个点 */
  const trackMove = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      if (!shownAt.current) return;
      const now = Date.now();
      if (now - lastMoveAt.current < 40) return;
      lastMoveAt.current = now;
      const rect = imgRef.current?.getBoundingClientRect();
      if (!rect || rect.width <= 0) return;
      const rx = (event.clientX - rect.left) / rect.width;
      const ry = (event.clientY - rect.top) / rect.height;
      if (rx < 0 || rx > 1 || ry < 0 || ry > 1) return;
      trail.current.push([Math.round(rx * data.width), Math.round(ry * data.height), now - shownAt.current]);
      if (trail.current.length > 40) trail.current.shift();
    },
    [data.width, data.height],
  );

  // 弹窗语义：打开时把焦点收进来，关闭后还给原来聚焦的元素
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const timer = window.setTimeout(() => cardRef.current?.focus(), 30);
    return () => {
      window.clearTimeout(timer);
      previous?.focus?.();
    };
  }, []);

  // Esc = 收起（和右上角「收起」一致），不打断后端等待
  useEffect(() => {
    if (!onDismiss) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onDismiss();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDismiss]);

  const busy = phase === "busy";
  // 自动识别进行中：禁用换图/提交，只保留「停止自动，我手动点」
  const autoRunning = Boolean(auto?.running);
  // 自动识别这一轮选的点。只有它属于当前这张图时才画，
  // 否则换图后会在新图上残留上一个点的坐标。
  const autoPoint =
    autoRunning && auto?.point && (auto.img === undefined || auto.img === data.img)
      ? { x: auto.point[0], y: auto.point[1] }
      : null;
  // 放大镜优先看用户的点；没有就看自动选的
  const focus = point ?? autoPoint;

  const stopAuto = useCallback(async () => {
    if (!onAutoStop) return;
    setPhase("busy");
    setMessage("正在停止自动识别…");
    try {
      const result = await onAutoStop();
      setPhase("idle");
      setMessage(result.message || "已切换为手动点选");
    } catch (error) {
      setPhase("error");
      setMessage((error as Error).message);
    }
  }, [onAutoStop]);

  const pick = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      if (busy || !loaded) return;
      if (autoRunning) {
        // 用户直接点图就是要自己来：先停掉自动识别，再记点位
        void stopAuto();
      }
      const rect = imgRef.current?.getBoundingClientRect();
      if (!rect || rect.width <= 0) return;
      const rx = (event.clientX - rect.left) / rect.width;
      const ry = (event.clientY - rect.top) / rect.height;
      if (rx < 0 || rx > 1 || ry < 0 || ry > 1) return;
      setPoint({ x: Math.round(rx * data.width), y: Math.round(ry * data.height) });
      if (phase === "error") {
        setPhase("idle");
        setMessage("已更新位置，确认后提交");
      } else {
        setMessage("确认位置无误后点「提交」");
      }
    },
    [busy, loaded, data.width, data.height, phase],
  );

  const submit = useCallback(async () => {
    if (busy || !point) return;
    setPhase("busy");
    setMessage("正在校验…");
    try {
      const result = await onSubmit(
        [[point.x, point.y, Math.max(0, Date.now() - (shownAt.current || Date.now()))]],
        trail.current.slice(),
      );
      if (result.ok) {
        setPhase("ok");
        setMessage(result.message);
        return;
      }
      if (result.captcha) {
        // 后端发现图已失效，顺手换了一张
        setData(result.captcha);
        setPoint(null);
        setLoaded(false);
      }
      // 没点中时保留红点：用户能看清刚才点偏到哪，直接在原位置附近微调
      setPhase("error");
      setMessage(result.message);
    } catch (error) {
      setPhase("error");
      setMessage((error as Error).message);
    }
  }, [busy, point, onSubmit]);

  const refresh = useCallback(async () => {
    if (busy) return;
    setPhase("busy");
    setMessage("正在换一张…");
    try {
      const next = await onRefresh();
      setData(next);
      setPoint(null);
      setLoaded(false);
      setPhase("idle");
      setMessage("点击图片上的目标字符");
    } catch (error) {
      setPhase("error");
      setMessage((error as Error).message);
    }
  }, [busy, onRefresh]);

  const retry = useCallback(async () => {
    if (busy || !onRetry) return;
    setPhase("busy");
    setMessage("正在重试…");
    try {
      const result = await onRetry();
      setPhase(result.ok ? "ok" : "error");
      setMessage(result.message);
    } catch (error) {
      setPhase("error");
      setMessage((error as Error).message);
    }
  }, [busy, onRetry]);

  return (
    <div className="study-captcha-layer">
      <div
        className="captcha-card study-captcha"
        role="dialog"
        aria-modal="true"
        aria-labelledby="study-captcha-title"
        tabIndex={-1}
        ref={cardRef}
      >
        <header className="study-captcha-head">
          <div>
            <h3 id="study-captcha-title">人机验证</h3>
            <p>{task?.name ? `通过后继续学习：${task.name}` : "通过后自动继续学习"}</p>
          </div>
          <button className="study-captcha-fold" onClick={onDismiss} title="收起到右下角（Esc）">
            收起
          </button>
        </header>

        {autoRunning && (
          <div className="study-captcha-auto-banner" role="status">
            <span className="study-captcha-auto-dot" aria-hidden />
            <span>
              正在本地自动识别（第 {auto?.round || 0} 张，不联网、不打码），没点中会自动换一张继续；
              直接在图上点一下即可接手自己点
            </span>
          </div>
        )}

        <div className="study-captcha-notice">
          <span className="study-captcha-notice-label">指令</span>
          {data.notice || "请按图片提示完成点击"}
        </div>

        <div
          className={`study-captcha-stage${busy ? " is-busy" : ""}${loaded ? "" : " is-loading"}`}
          style={{ aspectRatio: `${data.width} / ${data.height}` }}
          onClick={pick}
          onMouseMove={trackMove}
        >
          <img
            ref={imgRef}
            src={data.background}
            alt={`验证码图片：${data.notice || "请按提示点击"}`}
            width={data.width}
            height={data.height}
            draggable={false}
            onLoad={() => {
              setLoaded(true);
              // 图真正显示出来才开始计时，轨迹的时间偏移以此为原点
              shownAt.current = Date.now();
              trail.current = [];
            }}
          />
          {autoPoint && (
            <span
              className="study-captcha-auto-point"
              style={{
                left: `${(autoPoint.x / Math.max(1, data.width)) * 100}%`,
                top: `${(autoPoint.y / Math.max(1, data.height)) * 100}%`,
              }}
              aria-hidden
            />
          )}
          {point && (
            <>
              <span
                className="study-captcha-ripple"
                style={{
                  left: `${(point.x / Math.max(1, data.width)) * 100}%`,
                  top: `${(point.y / Math.max(1, data.height)) * 100}%`,
                }}
              />
              <span
                className="study-captcha-dot"
                style={{
                  left: `${(point.x / Math.max(1, data.width)) * 100}%`,
                  top: `${(point.y / Math.max(1, data.height)) * 100}%`,
                }}
              />
            </>
          )}
          {!loaded && <span className="study-captcha-loading">加载中…</span>}
        </div>

        <div
          className={`study-captcha-message-line${autoRunning ? " is-auto" : ""}`}
          role="status"
          aria-live="polite"
        >
          {autoRunning && <span className="study-captcha-spinner" aria-hidden />}
          <span>{autoRunning ? auto?.status || "正在自动识别…" : message}</span>
        </div>

        <div className="study-captcha-status">
          <span
            className={`study-captcha-lens${focus ? "" : " is-empty"}${autoPoint ? " is-auto" : ""}`}
            style={
              focus
                ? {
                    backgroundImage: `url(${data.background})`,
                    backgroundSize: `${data.width * 4}px ${data.height * 4}px`,
                    backgroundPosition: `${28 - focus.x * 4}px ${28 - focus.y * 4}px`,
                  }
                : undefined
            }
            title={
              focus
                ? `当前点位 ${focus.x},${focus.y}${autoPoint ? "（自动识别选的）" : ""}`
                : autoRunning
                  ? "自动识别正在看这张图"
                  : "先在图片上点一下"
            }
          />
          {!autoRunning && <p className={`study-captcha-message ${phase}`}>{message}</p>}
        </div>

        <div className="study-captcha-actions">
          {autoRunning ? (
            <>
              <button className="btn btn-quiet" onClick={onDismiss} title="收起到右下角，自动识别继续">
                收起
              </button>
              <button className="btn btn-primary" onClick={() => void stopAuto()}>
                停止自动，我手动点
              </button>
            </>
          ) : (
            <>
              <button className="btn btn-quiet" onClick={() => void refresh()} disabled={busy}>
                <IconRefresh size={15} />
                换一张
              </button>
              <button
                className="btn btn-primary"
                onClick={() => void submit()}
                disabled={busy || !point}
              >
                <IconCheck size={15} />
                {busy ? "校验中…" : "提交"}
              </button>
            </>
          )}
        </div>

        <div className="study-captcha-fallback">
          <span>一直不通过？用浏览器打开智慧树学习页手工完成，再</span>
          <button className="study-captcha-link" disabled={busy} onClick={() => void retry()}>
            我已处理，重试上报
          </button>
        </div>
      </div>
    </div>
  );
}
