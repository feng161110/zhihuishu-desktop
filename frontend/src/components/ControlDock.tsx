import type { EngineState } from "../types";
import { clamp, classNames, formatDuration, STATUS_TEXT } from "../utils";
import { IconPause, IconPlay, IconStop } from "./Icons";

interface Props {
  engine: EngineState;
  speed: number;
  strictFull: boolean;
  autoSolve: boolean;
  /** 当前正在播的这条在平台侧是否已完成 */
  currentCompleted?: boolean;
  selectedCount: number;
  totalCount: number;
  busy?: boolean;
  onSpeed: (value: number) => void;
  onStrictFull: (value: boolean) => void;
  onAutoSolve: (value: boolean) => void;
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
}

const PRESETS = [1.0, 1.25, 1.5, 2.0];

export default function ControlDock({
  engine,
  speed,
  strictFull,
  autoSolve,
  currentCompleted,
  selectedCount,
  totalCount,
  busy,
  onSpeed,
  onStrictFull,
  onAutoSolve,
  onStart,
  onPause,
  onResume,
  onStop,
}: Props) {
  const current = engine.current;
  const running = engine.status === "running";
  const paused = engine.status === "paused";
  const stopping = engine.status === "stopping";
  const percent = current.total > 0 ? clamp((current.watched / current.total) * 100, 0, 100) : 0;
  const locked = running || paused || stopping;

  return (
    <footer className="dock">
      <div className="dock-now">
        <div className="dock-head">
          <span className={classNames("live", running && "on")} aria-hidden />
          <strong title={current.name}>{current.name || "当前没有播放任务"}</strong>
          {currentCompleted && (
            <span className="task-done-tag" title="平台侧已判定完成，当前正在继续播放">
              已完成
            </span>
          )}
          <em>{STATUS_TEXT[engine.status] || engine.status}</em>
        </div>
        <div className="dock-timeline">
          <span className="dock-time num">{formatDuration(current.watched)}</span>
          <span
            className="dock-bar"
            role="progressbar"
            aria-label="当前视频播放进度"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(percent)}
          >
            <i style={{ width: `${percent}%` }} />
          </span>
          <span className="dock-time num">{formatDuration(current.total)}</span>
          <span className="dock-queue num">
            {engine.finished}/{engine.total || selectedCount}
          </span>
        </div>
      </div>

      <div className="dock-config">
        <div className="speed-set" role="group" aria-label="播放倍速">
          {PRESETS.map((preset) => (
            <button
              key={preset}
              className={classNames("speed-pill", Math.abs(speed - preset) < 0.001 && "active")}
              onClick={() => onSpeed(preset)}
              disabled={locked}
            >
              {preset.toString().replace(/\.0$/, "")}x
            </button>
          ))}
          <input
            className="speed-field num"
            value={speed}
            aria-label="自定义倍速"
            onChange={(event) => {
              const value = Number.parseFloat(event.target.value);
              if (!Number.isNaN(value)) onSpeed(clamp(value, 1, 3));
            }}
            disabled={locked}
            inputMode="decimal"
          />
        </div>

        <label
          className="toggle"
          title="不勾选：完全按平台判定——平台说完成就跳过、也在平台判完成时切下一条。勾选：跳过与收手都按实际看满时长算，适合补进度。默认不勾选。"
        >
          <input
            type="checkbox"
            checked={strictFull}
            onChange={(event) => onStrictFull(event.target.checked)}
            disabled={locked}
          />
          <span className="toggle-track">
            <i />
          </span>
          严格 100%
          <b
            className="toggle-note"
            title="平台通常在进度接近但不到 100% 时就标记完成；勾选后不认这个判定，只有实际看满 100% 才算完成，未看满的会补到满。"
          >
            !
          </b>
        </label>

        <label
          className="toggle"
          title="勾选：学习页人机验证先用本地模型自动点选，点错自动换图，也可随时切手动。不勾选：只弹窗手动点。"
        >
          <input
            type="checkbox"
            checked={autoSolve}
            onChange={(event) => onAutoSolve(event.target.checked)}
            disabled={locked}
          />
          <span className="toggle-track">
            <i />
          </span>
          自动识别验证码
          <b className="toggle-note" title="本地 OpenCV + ddddocr 识别，不联网、不打码；失败会自动换图重试。">
            !
          </b>
        </label>
      </div>

      <div className="dock-actions">
        {!locked && (
          <button className="btn btn-primary" onClick={onStart} disabled={busy || selectedCount === 0}>
            <IconPlay size={14} />
            开始学习
            <em>
              {selectedCount}/{totalCount}
            </em>
          </button>
        )}
        {running && (
          <button className="btn btn-quiet" onClick={onPause}>
            <IconPause size={14} />
            暂停
          </button>
        )}
        {paused && (
          <button className="btn btn-primary" onClick={onResume}>
            <IconPlay size={14} />
            继续
          </button>
        )}
        {locked && (
          <button className="btn btn-danger" onClick={onStop} disabled={stopping}>
            <IconStop size={13} />
            {stopping ? "停止中" : "停止"}
          </button>
        )}
      </div>
    </footer>
  );
}
