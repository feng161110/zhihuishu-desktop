export interface Profile {
  name: string;
  username: string;
  avatar?: string;
}

export interface Course {
  id: string;
  name: string;
  secret: string;
  school?: string;
  term?: string;
  cover?: string;
}

export interface CourseInfo {
  id: string;
  name: string;
  school: string;
  term: string;
  cover: string;
  recruit_id: number;
  course_id: number;
}

export interface Task {
  id: string;
  name: string;
  chapter: string;
  video_sec: number;
  studied: number;
  watch_state: number;
  completed: boolean;
  big_id?: number;
  small_id?: number;
  video_id?: number;
  chapter_id?: number;
}

export interface Chapter {
  name: string;
  task_ids: string[];
}

export interface QueueItem {
  task_id: string;
  name: string;
  status: TaskStatus;
  watched: number;
  total: number;
}

export type TaskStatus = "pending" | "playing" | "paused" | "done" | "skipped" | "failed" | "stopped";

export interface EngineState {
  status: "idle" | "running" | "paused" | "stopping";
  speed: number;
  current: {
    task_id: string | null;
    name: string;
    watched: number;
    total: number;
    block: number;
    blocks: number;
  };
  queue: QueueItem[];
  total: number;
  finished: number;
}

export type LogLevel = "info" | "success" | "warn" | "error" | "debug";

export interface LogEntry {
  type: "log";
  level: LogLevel;
  message: string;
  time: string;
  ts?: number;
}

export interface Settings {
  speed: number;
  auto_solve: boolean;
  strict_full: boolean;
  remember_password: boolean;
  max_retry: number;
  log_api: boolean;
}

export interface ResumableSession {
  course_id: string;
  task_ids: string[];
  speed: number;
}

export interface AppState {
  settings: Settings;
  authenticated: boolean;
  profile: Profile | null;
  courses: Course[];
  course: CourseInfo | null;
  tasks: Task[];
  chapters: Chapter[];
  engine: EngineState;
  captcha?: StudyCaptchaState;
  resumable?: ResumableSession | null;
  logs: LogEntry[];
  data_dir: string;
}

/** 后端当前挂起的学习页验证码（引擎在等用户完成） */
export interface StudyCaptchaState {
  active: boolean;
  task: { id?: string; name?: string };
  payload?: StudyCaptchaPayload;
  validate?: string;
  auto?: { running: boolean; round: number; img?: number; point?: [number, number] | null };
}

export interface StudyCaptchaAuto {
  running: boolean;
  round: number;
  status: string;
  /** 点位属于哪张图；前端只在自己当前这张图上显示它 */
  img?: number;
  /** 自动识别这一轮选中的坐标，会在弹窗图片上标出来 */
  point?: [number, number] | null;
}

export interface CaptchaPayload {
  background: string;
  piece: string;
  width: number;
  height: number;
  piece_width: number;
  piece_height: number;
  type?: number;
}

export interface LoginResult {
  status: "ok" | "captcha" | "error";
  profile?: Profile;
  captcha?: CaptchaPayload;
  message?: string;
}

export interface SubmitResult {
  ok: boolean;
  message: string;
  profile?: Profile;
  captcha?: CaptchaPayload;
  expired?: boolean;
}

export interface SolveResult {
  ratio: number | null;
  confidence: number;
  method: string;
  x?: number;
  width?: number;
  message: string;
  expired?: boolean;
}

/** 学习页人机验证（易盾空间推理）：一张图 + 一句中文提示语 */
export interface StudyCaptchaPayload {
  background: string;
  notice: string;
  width: number;
  height: number;
  type: number;
  /** 每次取图递增，用来判断自动标的点是不是当前这张图 */
  img?: number;
}

export interface StudyCaptchaSubmitResult {
  ok: boolean;
  message: string;
  validate?: string;
  expired?: boolean;
  captcha_failed?: boolean;
  /** 图上凭证已失效时后端会顺手换一张，前端直接换图 */
  captcha?: StudyCaptchaPayload;
}

export interface CourseDetail {
  course: CourseInfo;
  tasks: Task[];
  chapters: Chapter[];
}

export interface TaskProgress {
  watched: number;
  total: number;
  status?: TaskStatus;
}

export interface TaskUpdate {
  task_id: string;
  status?: TaskStatus;
  watched?: number | null;
  total?: number;
}

export interface TaskPatch {
  id: string;
  completed: boolean;
  watch_state: number;
  studied: number;
}
