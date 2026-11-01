import { useCallback, useEffect, useRef, useState } from "react";
import { api, connectEvents, detachEngine, waitForBackend } from "../api";
import { bringWindowToFront } from "../utils";
import type {
  AppState,
  CourseDetail,
  EngineState,
  LogEntry,
  StudyCaptchaAuto,
  StudyCaptchaPayload,
  Task,
  TaskPatch,
  TaskProgress,
  TaskUpdate,
} from "../types";

/** 启动画面最短展示时长（毫秒），保证启动动画能被看到 */
const MIN_BOOT_MS = 1600;

export const EMPTY_ENGINE: EngineState = {
  status: "idle",
  speed: 1,
  current: { task_id: null, name: "", watched: 0, total: 0, block: 0, blocks: 0 },
  queue: [],
  total: 0,
  finished: 0,
};

export type Connection = "connecting" | "live" | "offline";

export interface Toast {
  id: number;
  level: "info" | "success" | "warn" | "error";
  text: string;
}

function progressFromEngine(engine: EngineState): Record<string, TaskProgress> {
  const next: Record<string, TaskProgress> = {};
  for (const item of engine.queue) {
    next[item.task_id] = { watched: item.watched, total: item.total, status: item.status };
  }
  return next;
}

/**
 * 合并进度快照：同一任务以本地更靠前的进度为准。
 * 轮询拿到的快照可能比 SSE 事件旧，直接覆盖会让进度条倒退。
 */
function mergeProgress(
  prev: Record<string, TaskProgress>,
  incoming: Record<string, TaskProgress>,
): Record<string, TaskProgress> {
  const next = { ...prev };
  for (const [taskId, item] of Object.entries(incoming)) {
    const local = next[taskId];
    if (!local) {
      next[taskId] = item;
      continue;
    }
    if (local.status === "done" || local.status === "skipped") continue;
    if (item.status === "done" || item.status === "skipped") {
      next[taskId] = item;
      continue;
    }
    next[taskId] =
      (item.watched ?? 0) >= (local.watched ?? 0) ? item : { ...item, watched: local.watched };
  }
  return next;
}

/** 用本地已判定完成/跳过的进度修正服务端任务列表，避免旧快照把完成状态改回去。 */
function mergeTasksWithProgress(tasks: Task[], progress: Record<string, TaskProgress>): Task[] {
  return tasks.map((task) => {
    const local = progress[task.id];
    if (!local || (local.status !== "done" && local.status !== "skipped")) return task;
    if (task.completed) return task;
    return {
      ...task,
      completed: true,
      watch_state: 1,
      studied: Math.max(task.studied, local.watched ?? 0),
    };
  });
}

/**
 * 数据层：负责快照、SSE 实时事件与所有后端动作。
 * 视图层只拿数据与动作，不再自己管理请求时序。
 */
export function useWorkspace() {
  const [snapshot, setSnapshot] = useState<AppState | null>(null);
  const [engine, setEngine] = useState<EngineState>(EMPTY_ENGINE);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [progress, setProgress] = useState<Record<string, TaskProgress>>({});
  const [connection, setConnection] = useState<Connection>("connecting");
  const [booting, setBooting] = useState(true);
  const [bootError, setBootError] = useState("");
  const [speed, setSpeed] = useState(1);
  const [strictFull, setStrictFull] = useState(false);
  const [autoSolve, setAutoSolve] = useState(true);
  const [toast, setToast] = useState<Toast | null>(null);
  // 学习页人机验证：非空时弹窗，用户点完图片坐标回传后端
  const [studyCaptcha, setStudyCaptcha] = useState<{
    payload: StudyCaptchaPayload;
    task: { id?: string; name?: string };
  } | null>(null);
  // 用户把弹窗收起到右下角（验证仍在后端等待）
  const [captchaHidden, setCaptchaHidden] = useState(false);
  // 自动识别的实时进度；用户点「停止自动」后停止
  const [captchaAuto, setCaptchaAuto] = useState<StudyCaptchaAuto | null>(null);

  const toastId = useRef(0);
  const engineRef = useRef(engine);
  const hydrated = useRef(false);
  const prevStatus = useRef<EngineState["status"]>("idle");
  const connectionRef = useRef<Connection>("connecting");
  // 用户刚改过设置（600ms 防抖保存）时，轮询快照不允许把输入覆盖回旧值
  const settingsDirty = useRef(false);

  engineRef.current = engine;

  const snapshotRef = useRef<AppState | null>(null);
  snapshotRef.current = snapshot;
  // 弹窗里当前显示的那张图：用来判断轮询快照是不是同一张，避免把用户的操作清掉
  const studyCaptchaRef = useRef(studyCaptcha);
  studyCaptchaRef.current = studyCaptcha;
  const progressRef = useRef<Record<string, TaskProgress>>({});
  progressRef.current = progress;
  connectionRef.current = connection;

  // 已经触发过“完成后刷新”的任务，避免每秒的引擎快照重复发请求
  const refreshedTasks = useRef<Set<string>>(new Set());
  const refreshing = useRef(false);
  const refreshPending = useRef(false);

  const notify = useCallback((text: string, level: Toast["level"] = "info") => {
    const id = ++toastId.current;
    setToast({ id, level, text });
    window.setTimeout(() => {
      setToast((prev) => (prev && prev.id === id ? null : prev));
    }, 3200);
  }, []);

  // dirty 只由「保存成功」清除，不再按时间自动清：
  // 保存失败时若提前解除保护，下一次轮询就会把用户刚改的倍速/开关冲回旧值。
  const markSettingsDirty = useCallback(() => {
    settingsDirty.current = true;
  }, []);

  const changeSpeed = useCallback(
    (value: number) => {
      markSettingsDirty();
      setSpeed(value);
    },
    [markSettingsDirty],
  );

  const changeStrictFull = useCallback(
    (value: boolean) => {
      markSettingsDirty();
      setStrictFull(value);
    },
    [markSettingsDirty],
  );

  const changeAutoSolve = useCallback(
    (value: boolean) => {
      markSettingsDirty();
      setAutoSolve(value);
    },
    [markSettingsDirty],
  );

  const applySnapshot = useCallback((next: AppState, syncSettings = false, force = false) => {
    // SSE 在线时引擎状态与日志以实时事件为准：轮询快照可能稍旧，
    // 直接覆盖会让暂停/停止按钮闪回旧状态。只有断线时才用快照校准。
    // force 用于「重连后的首次校准」：那时 connection 已经被置成 live，
    // 不强制的话断线期间错过的 engine/logs 永远补不回来。
    const live = !force && connectionRef.current === "live";
    setSnapshot(live ? { ...next, tasks: mergeTasksWithProgress(next.tasks, progressRef.current) } : next);
    if (!live) {
      setEngine(next.engine);
      setLogs(next.logs || []);
    }
    setProgress((prev) => mergeProgress(prev, progressFromEngine(next.engine)));
    // 页面刷新后 SSE 历史不会重放，这里按后端挂起状态恢复验证码弹窗
    const pendingCaptcha = next.captcha;
    const shown = studyCaptchaRef.current;
    const nextBackground = pendingCaptcha?.payload?.background ?? "";
    if (pendingCaptcha?.active && pendingCaptcha.payload) {
      // 轮询快照每次都是全新的 payload 对象，只有图片内容真的变了才更新，
      // 否则每 4 秒就把用户正在点的红点、错误提示和自动进度清掉。
      if (!shown || shown.payload.background !== nextBackground) {
        setStudyCaptcha({ payload: pendingCaptcha.payload, task: pendingCaptcha.task ?? {} });
        // 新验证码来了就把「收起」复位：轮询补齐这条路径原来不会复位，
        // 用户之前收起了弹窗，新图只留在右下角入口，看起来像卡住。
        setCaptchaHidden(false);
      }
      const autoRunning = Boolean(pendingCaptcha.auto?.running);
      const autoImg = pendingCaptcha.auto?.img;
      setCaptchaAuto((prev) =>
        // img 也要一起比：轮询快照里没有自动选的点，
        // 只比 round/running 的话换个判定就会把点位冲掉
        prev?.running === autoRunning &&
        prev?.round === (pendingCaptcha.auto?.round ?? 0) &&
        prev?.img === autoImg
          ? prev
          : {
              running: autoRunning,
              round: pendingCaptcha.auto?.round ?? 0,
              img: autoImg,
              status: "正在自动识别…",
            },
      );
    } else if (!pendingCaptcha?.active) {
      setStudyCaptcha(null);
      setCaptchaAuto(null);
    }
    if (syncSettings || !settingsDirty.current) {
      setSpeed(next.settings.speed ?? 1);
      setStrictFull(Boolean(next.settings.strict_full));
      setAutoSolve(Boolean(next.settings.auto_solve ?? true));
    }
  }, []);

  const refresh = useCallback(async (force = false) => {
    applySnapshot(await api.state(), false, force);
  }, [applySnapshot]);

  /**
   * 合并服务端下发的课程详情：本地已经判定完成的任务不允许被旧数据回退，
   * 否则刚播完就刷新时，服务端尚未落库会让进度条倒退。
   */
  const applyCourseDetail = useCallback((detail: CourseDetail) => {
    setSnapshot((prev) => {
      if (!prev) return prev;
      const tasks = mergeTasksWithProgress(detail.tasks, progressRef.current);
      return { ...prev, course: detail.course, tasks, chapters: detail.chapters };
    });
  }, []);

  /** 每完成一条视频就同步一次进度；多次触发会合并，避免并发请求打满后端。 */
  const scheduleProgressRefresh = useCallback(() => {
    refreshPending.current = true;
    if (refreshing.current) return;
    refreshing.current = true;
    void (async () => {
      try {
        // 留一点时间让最后一次进度上报落地，再拉取服务端数据
        await new Promise((resolve) => window.setTimeout(resolve, 500));
        while (refreshPending.current) {
          refreshPending.current = false;
          if (!snapshotRef.current?.course) break;
          try {
            applyCourseDetail(await api.refreshProgress());
          } catch {
            // 刷新失败不影响播放，单集进度仍由 SSE 事件实时更新
          }
        }
      } finally {
        refreshing.current = false;
      }
    })();
  }, [applyCourseDetail]);

  /** 上次关窗时任务被中断，重新打开后自动续播（主动点“停止”的不会被记住）。 */
  const restoreSession = useCallback(
    async (next: AppState) => {
      if (next.engine.status !== "idle" || !next.resumable) return;
      try {
        const result = await api.restore();
        if (result.restored) {
          applySnapshot(await api.state());
          notify("已自动续播上次未完成的任务", "success");
        }
      } catch {
        // 续播失败时保持空闲，用户可手动点击开始
      }
    },
    [applySnapshot, notify],
  );

  const bootstrap = useCallback(async () => {
    setBooting(true);
    setBootError("");
    const startedAt = performance.now();
    try {
      await waitForBackend();
      let next = await api.state();
      if (next.authenticated && next.courses.length === 0) {
        // 本地会话恢复登录时课程在后台同步，这里补一次，避免用户看到空列表
        try {
          // force=false：后端后台线程已同步完成时直接复用，不会重复请求
          await api.courses();
          next = await api.state();
        } catch {
          // 同步失败时保留空列表，用户仍可在侧栏手动刷新
        }
      }
      applySnapshot(next);
      hydrated.current = true;
      // 续播可能还要重新拉课程，放到后台跑，不拖慢启动画面
      void restoreSession(next);
    } catch (error) {
      setBootError((error as Error).message);
    } finally {
      // 启动画面至少停留 1.6s：后端热启动往往不到 1s，
      // 不兜底的话启动动画会一闪而过，看起来像没加载出来
      const remain = MIN_BOOT_MS - (performance.now() - startedAt);
      if (remain > 0) {
        await new Promise((resolve) => window.setTimeout(resolve, remain));
      }
      setBooting(false);
    }
  }, [applySnapshot, restoreSession]);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  // 关窗兜底：让后端立刻结束任务（保留队列），避免前端关掉后还在后台刷课
  useEffect(() => {
    const onLeave = () => detachEngine();
    window.addEventListener("beforeunload", onLeave);
    return () => window.removeEventListener("beforeunload", onLeave);
  }, []);

  // ---------------------------------------------------------------- 实时事件
  useEffect(() => {
    const dispose = connectEvents({
      onOpen: () => {
        const wasOffline = connectionRef.current === "offline";
        setConnection("live");
        // 重连后补一次全量快照，弥补断线期间错过的事件。
        // 必须 force：此刻 connection 已是 live，否则 applySnapshot 会跳过 engine/logs。
        if (wasOffline) void refresh(true).catch(() => undefined);
      },
      onError: () => setConnection("offline"),
      onEngine: (next) => {
        setEngine(next);
        setProgress((prev) => {
          if (next.queue.length === 0) return prev;
          const copy = { ...prev };
          for (const item of next.queue) {
            copy[item.task_id] = { watched: item.watched, total: item.total, status: item.status };
          }
          return copy;
        });
      },
      onTask: (update: TaskUpdate) =>
        setProgress((prev) => {
          const old = prev[update.task_id];
          return {
            ...prev,
            [update.task_id]: {
              watched: update.watched ?? old?.watched ?? 0,
              total: update.total ?? old?.total ?? 0,
              status: update.status ?? old?.status,
            },
          };
        }),
      onTaskPatch: (patch: TaskPatch) => {
        setSnapshot((prev) =>
          prev
            ? {
                ...prev,
                tasks: prev.tasks.map((task) =>
                  task.id === patch.id
                    ? { ...task, completed: patch.completed, watch_state: patch.watch_state, studied: patch.studied }
                    : task,
                ),
              }
            : prev,
        );
        setProgress((prev) => ({
          ...prev,
          [patch.id]: {
            watched: patch.studied,
            total: prev[patch.id]?.total ?? patch.studied,
            // 必须尊重 completed：无条件写 done 会让任务变成「只能前进不能后退」，
            // 服务端之后的纠正（重播、进度被重置）永远覆盖不进来。
            status: patch.completed ? "done" : "playing",
          },
        }));
      },
      onLog: (entry) => setLogs((prev) => [...prev.slice(-399), entry]),
      onCaptcha: (action, payload, task, auto) => {
        if (action === "required" && payload) {
          setStudyCaptcha({ payload, task: task ?? {} });
          setCaptchaHidden(false);
          // 用户可能把窗口最小化或在别的窗口上：先把本窗口抬到最前再提示
          void bringWindowToFront();
          notify("平台要求人机验证，请在弹窗中完成", "warn");
        } else if (action === "auto" && auto) {
          setCaptchaAuto(auto);
        } else if (action === "solved" || action === "cancelled") {
          setStudyCaptcha(null);
          setCaptchaAuto(null);
          setCaptchaHidden(false);
        }
      },
    });
    return dispose;
  }, [refresh, notify]);

  // SSE 断线或队列运行时的兜底轮询，保证进度不会停在某一帧
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      if (connection === "live" && engineRef.current.status === "idle") return;
      api
        .state()
        .then(applySnapshot)
        .catch(() => setConnection("offline"));
    }, 4000);
    return () => window.clearInterval(timer);
  }, [connection, applySnapshot]);

  // 回到前台立刻校准一次
  useEffect(() => {
    const onVisible = () => {
      if (!document.hidden) {
        void refresh().catch(() => setConnection("offline"));
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refresh]);

  // 队列结束后从服务端校准完成状态（避免 UI 与服务端不一致）
  useEffect(() => {
    const previous = prevStatus.current;
    prevStatus.current = engine.status;
    if (previous !== "idle" && engine.status === "idle" && snapshot?.course) {
      void api
        .refreshProgress()
        .then((detail) => {
          applyCourseDetail(detail);
          setProgress({});
        })
        .catch(() => undefined);
    }
  }, [engine.status, snapshot?.course, applyCourseDetail]);

  // 每完成一条视频就自动同步一次当前课程进度（支持连播时逐条刷新）
  useEffect(() => {
    const fresh: string[] = [];
    for (const item of engine.queue) {
      if (item.status === "done" && !refreshedTasks.current.has(item.task_id)) {
        refreshedTasks.current.add(item.task_id);
        fresh.push(item.task_id);
      }
    }
    if (fresh.length === 0) return;
    scheduleProgressRefresh();
  }, [engine, scheduleProgressRefresh]);

  // 设置项：speed / strict_full / auto_solve 合并成一次写入（不要依赖 snapshot，否则每次轮询都会重写）
  useEffect(() => {
    if (!hydrated.current) return;
    const timer = window.setTimeout(() => {
      api
        .saveSettings({ speed, strict_full: strictFull, auto_solve: autoSolve })
        .then(() => {
          settingsDirty.current = false;
        })
        .catch((error) => notify(`设置保存失败：${(error as Error).message}`, "error"));
    }, 600);
    return () => window.clearTimeout(timer);
  }, [speed, strictFull, autoSolve, notify]);

  // ---------------------------------------------------------------- 动作
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (event.code === "Space" && engineRef.current.status !== "idle") {
        event.preventDefault();
        const next = engineRef.current.status === "running" ? api.pause() : api.resume();
        next.then((result) => setEngine(result.engine)).catch(() => undefined);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const selectCourse = useCallback(
    async (courseId: string): Promise<CourseDetail | null> => {
      if (engineRef.current.status !== "idle") {
        notify("请先停止当前播放", "error");
        return null;
      }
      try {
        const detail = await api.selectCourse(courseId);
        refreshedTasks.current.clear();
        setSnapshot((prev) =>
          prev ? { ...prev, course: detail.course, tasks: detail.tasks, chapters: detail.chapters } : prev,
        );
        setProgress({});
        return detail;
      } catch (error) {
        notify((error as Error).message, "error");
        return null;
      }
    },
    [notify],
  );

  const reloadCourses = useCallback(async () => {
    try {
      await api.courses(true);
      await refresh();
      notify("课程列表已更新", "success");
    } catch (error) {
      notify((error as Error).message, "error");
    }
  }, [refresh, notify]);

  /**
   * 只重查学习进度（1 次请求）。
   * 不能走 /api/courses/refresh：那条是「重新选课」，播放中必然 409，
   * 而且会把整门课的章节结构和任务对象重建一遍。
   */
  const refreshProgress = useCallback(async () => {
    if (!snapshotRef.current?.course) return;
    try {
      applyCourseDetail(await api.refreshProgress());
      notify("学习进度已刷新", "success");
    } catch (error) {
      notify((error as Error).message, "error");
    }
  }, [applyCourseDetail, notify]);

  const start = useCallback(
    async (taskIds: string[], only?: boolean) => {
      if (taskIds.length === 0) {
        notify("请先勾选要学习的视频", "error");
        return false;
      }
      refreshedTasks.current.clear();
      try {
        const result = await api.start({
          task_ids: taskIds,
          speed,
          // 单集“播放本节”强制重播；批量时一律交给“平台判定 / 严格 100%”过滤
          replay_completed: Boolean(only),
          strict_full: strictFull,
        });
        setEngine(result.engine);
        setProgress((prev) => {
          const copy = { ...prev };
          for (const item of result.engine.queue) {
            if (!copy[item.task_id]) {
              copy[item.task_id] = { watched: item.watched, total: item.total, status: item.status };
            }
          }
          return copy;
        });
        notify(only ? "开始播放本节" : "已加入队列，开始学习", "success");
        return true;
      } catch (error) {
        notify((error as Error).message, "error");
        return false;
      }
    },
    [speed, strictFull, notify],
  );

  const control = useCallback(
    async (action: "pause" | "resume" | "stop") => {
      try {
        const result =
          action === "pause" ? await api.pause() : action === "resume" ? await api.resume() : await api.stop();
        setEngine(result.engine);
      } catch (error) {
        notify((error as Error).message, "error");
        // 动作失败时与后端校准，避免按钮停在已失效的状态
        void refresh().catch(() => undefined);
      }
    },
    [notify, refresh],
  );

  /** 提交学习页验证码的点击坐标（背景图原始像素）+ 真实鼠标轨迹；成功由后端推 solved 事件关窗 */
  const submitStudyCaptcha = useCallback(
    async (points: number[][], trace: number[][] = []) => {
      const result = await api.studyCaptchaSubmit(points, trace);
      if (result.ok) setStudyCaptcha(null);
      return result;
    },
    [],
  );

  /** 换一张验证码（用户看不清时） */
  const refreshStudyCaptcha = useCallback(async () => {
    const payload = await api.studyCaptchaRefresh();
    setStudyCaptcha((prev) => (prev ? { ...prev, payload } : prev));
    return payload;
  }, []);

  /** 用户已在浏览器手工完成验证，让后端直接重试上报 */
  const confirmStudyCaptcha = useCallback(async () => {
    const result = await api.studyCaptchaRetry();
    if (result.ok) setStudyCaptcha(null);
    return result;
  }, []);

  /** 停止自动识别，保留当前这张图由用户手动点选 */
  const stopStudyCaptchaAuto = useCallback(async () => {
    try {
      const result = await api.studyCaptchaAutoStop();
      setCaptchaAuto({ running: false, round: 0, status: result.message });
      return result;
    } catch (error) {
      notify((error as Error).message, "error");
      throw error;
    }
  }, [notify]);

  const hideStudyCaptcha = useCallback(() => setCaptchaHidden(true), []);
  const showStudyCaptcha = useCallback(() => setCaptchaHidden(false), []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
      setProgress({});
      setSnapshot((prev) => (prev ? { ...prev, authenticated: false, profile: null, course: null, tasks: [], chapters: [] } : prev));
      await refresh();
    } catch (error) {
      notify((error as Error).message, "error");
    }
  }, [refresh, notify]);

  return {
    snapshot,
    engine,
    logs,
    progress,
    connection,
    booting,
    bootError,
    speed,
    strictFull,
    autoSolve,
    toast,
    studyCaptcha,
    captchaHidden,
    captchaAuto,
    confirmStudyCaptcha,
    stopStudyCaptchaAuto,
    hideStudyCaptcha,
    showStudyCaptcha,
    setSpeed: changeSpeed,
    setStrictFull: changeStrictFull,
    setAutoSolve: changeAutoSolve,
    submitStudyCaptcha,
    refreshStudyCaptcha,
    notify,
    refresh,
    bootstrap,
    selectCourse,
    reloadCourses,
    refreshProgress,
    start,
    control,
    logout,
  };
}
