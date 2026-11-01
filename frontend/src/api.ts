import type {
  AppState,
  CaptchaPayload,
  CourseDetail,
  EngineState,
  LoginResult,
  LogEntry,
  SolveResult,
  StudyCaptchaAuto,
  StudyCaptchaPayload,
  StudyCaptchaSubmitResult,
  SubmitResult,
  TaskPatch,
  TaskUpdate,
} from "./types";

export const API_BASE: string =
  (import.meta.env.VITE_API_BASE as string | undefined) ?? "http://127.0.0.1:8765";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(API_BASE + path, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
  } catch {
    // 后端没起来 / 正在重启：把浏览器的英文 TypeError 换成人话，
    // 否则用户看到的是「Failed to fetch」，完全不知道发生了什么
    throw new Error("无法连接后台服务，请稍候重试；若持续出现请重启应用");
  }
  if (!response.ok) {
    let message = `请求失败（${response.status}）`;
    try {
      const data = (await response.json()) as { detail?: unknown; message?: unknown };
      // FastAPI 的 422 里 detail 是对象数组，直接 String() 会变成 [object Object]
      if (typeof data.detail === "string" && data.detail) {
        message = data.detail;
      } else if (Array.isArray(data.detail) && data.detail.length > 0) {
        const parts = data.detail
          .map((item) => (item && typeof item === "object" && "msg" in item ? String(item.msg) : ""))
          .filter(Boolean);
        if (parts.length > 0) message = parts.join("；");
      } else if (typeof data.message === "string" && data.message) {
        message = data.message;
      }
    } catch {
      /* 非 JSON 响应（如网关 502 页面），保留状态码文案 */
    }
    throw new Error(message);
  }
  return (await response.json()) as T;
}

const post = <T,>(path: string, body?: unknown) =>
  request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

export const api = {
  state: () => request<AppState>("/api/state"),
  login: (body: { username: string; password: string; auto_solve: boolean; remember: boolean }) =>
    post<LoginResult>("/api/auth/login", body),
  savedCredentials: () =>
    request<{ username: string; password: string; remember: boolean }>("/api/auth/credentials"),
  captchaNew: () => post<CaptchaPayload>("/api/auth/captcha/new"),
  captchaSolve: () => post<SolveResult>("/api/auth/captcha/solve"),
  captchaSubmit: (ratio: number) => post<SubmitResult>("/api/auth/captcha/submit", { ratio }),
  studyCaptchaRefresh: () => post<StudyCaptchaPayload>("/api/captcha/study/refresh"),
  studyCaptchaSubmit: (points: number[][], trace: number[][] = []) =>
    post<StudyCaptchaSubmitResult>("/api/captcha/study/submit", { points, trace }),
  studyCaptchaRetry: () => post<{ ok: boolean; message: string }>("/api/captcha/study/retry"),
  studyCaptchaAutoStop: () => post<{ ok: boolean; message: string }>("/api/captcha/study/auto/stop"),
  logout: () => post<{ ok: boolean }>("/api/auth/logout"),
  courses: (force = false) => request<{ courses: AppState["courses"] }>(`/api/courses?force=${force}`),
  selectCourse: (courseId: string) => post<CourseDetail>("/api/courses/select", { course_id: courseId }),
  refreshCourse: () => post<CourseDetail>("/api/courses/refresh"),
  refreshProgress: () => post<CourseDetail>("/api/courses/progress"),
  start: (body: {
    task_ids: string[];
    speed: number;
    replay_completed: boolean;
    strict_full: boolean;
  }) => post<{ ok: boolean; engine: EngineState }>("/api/engine/start", body),
  pause: () => post<{ engine: EngineState }>("/api/engine/pause"),
  resume: () => post<{ engine: EngineState }>("/api/engine/resume"),
  stop: (keepSession = false) =>
    post<{ engine: EngineState }>(`/api/engine/stop${keepSession ? "?keep_session=1" : ""}`),
  restore: () =>
    post<{ ok: boolean; restored: boolean; engine: EngineState; message?: string }>("/api/engine/restore"),
  saveSettings: (body: Record<string, unknown>) => post<{ settings: AppState["settings"] }>("/api/settings", body),
};

/**
 * 窗口关闭时的兜底：通知后端结束任务但保留队列，下次打开自动续播。
 * Tauri 退出时 Rust 侧还会再发一次，这里只覆盖 webview 被直接销毁的情况。
 */
export function detachEngine(): void {
  try {
    void fetch(`${API_BASE}/api/engine/stop?keep_session=1`, { method: "POST", keepalive: true });
  } catch {
    /* ignore */
  }
}

export async function waitForBackend(timeoutMs = 40000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${API_BASE}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (response.ok) return;
    } catch {
      /* retry */
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error("后端服务未响应，请在 backend 目录执行：uvicorn main:app --host 127.0.0.1 --port 8765");
}

export interface EventHandlers {
  onOpen?: () => void;
  onError?: () => void;
  onEngine?: (engine: EngineState) => void;
  onLog?: (entry: LogEntry) => void;
  onTask?: (update: TaskUpdate) => void;
  onTaskPatch?: (patch: TaskPatch) => void;
  /** 学习页人机验证：action = required / solved / cancelled / auto */
  onCaptcha?: (
    action: string,
    payload?: StudyCaptchaPayload,
    task?: { id?: string; name?: string },
    auto?: StudyCaptchaAuto,
  ) => void;
}

export function connectEvents(handlers: EventHandlers): () => void {
  const source = new EventSource(`${API_BASE}/api/events`);
  source.onopen = () => handlers.onOpen?.();
  source.onerror = () => handlers.onError?.();
  source.onmessage = (event) => {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }
    switch (data.type) {
      case "engine":
        handlers.onEngine?.(data.engine as EngineState);
        break;
      case "log":
        handlers.onLog?.(data as unknown as LogEntry);
        break;
      case "task":
        if (data.task) handlers.onTaskPatch?.(data.task as unknown as TaskPatch);
        else handlers.onTask?.(data as unknown as TaskUpdate);
        break;
      case "captcha":
        handlers.onCaptcha?.(
          String(data.action ?? ""),
          data.captcha as StudyCaptchaPayload | undefined,
          data.task as { id?: string; name?: string } | undefined,
          data.auto as unknown as StudyCaptchaAuto | undefined,
        );
        break;
      default:
        break;
    }
  };
  return () => source.close();
}
