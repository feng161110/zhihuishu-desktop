import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import type { Task, TaskProgress } from "./types";

export type TaskFilter = "all" | "todo" | "done";

/**
 * 需要用户立刻处理时（人机验证弹窗）把窗口拿到最前：
 * 还原最小化 → 显示 → 聚焦，本来不在前台时再让任务栏图标闪一下。
 *
 * 窗口已经在前台时这些调用都是空操作，不会打断用户操作；
 * 浏览器里跑（npm run dev）时只做 window.focus()。
 */
export async function bringWindowToFront(): Promise<void> {
  if (!isTauri()) {
    window.focus();
    return;
  }
  // 先判断再聚焦，聚焦后 hasFocus 就变成 true 了
  const needsAttention = document.visibilityState !== "visible" || !document.hasFocus();
  const win = getCurrentWindow();
  await Promise.all([win.unminimize().catch(() => {}), win.show().catch(() => {})]);
  await win.setFocus().catch(() => {});
  if (needsAttention) {
    await win.requestUserAttention(UserAttentionType.Critical).catch(() => {});
  }
}

/**
 * 判断某条任务在当前关键词 + 状态筛选下是否可见。
 * 列表渲染与“全选”共用同一套判断，避免两边口径不一致。
 */
export function matchesTaskFilter(
  task: Task,
  filter: TaskFilter,
  query: string,
  progress: Record<string, TaskProgress>,
): boolean {
  const keyword = query.trim().toLowerCase();
  if (keyword && !task.name.toLowerCase().includes(keyword) && !task.chapter.toLowerCase().includes(keyword)) {
    return false;
  }
  // 「完成」只在这里定义一次：列表、页签计数、顶部统计都调它，
  // 否则同一批任务会出现「列表里有、计数里没有」的矛盾。
  const state = progress[task.id]?.status;
  const done = task.completed || state === "done" || state === "skipped";
  if (filter === "todo") return !done;
  if (filter === "done") return done;
  return true;
}

export function formatDuration(seconds: number): string {
  const value = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(value / 3600);
  const m = Math.floor((value % 3600) / 60);
  const s = value % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function classNames(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

export const STATUS_TEXT: Record<string, string> = {
  pending: "未开始",
  playing: "学习中",
  paused: "已暂停",
  done: "已完成",
  skipped: "已跳过",
  failed: "失败",
  stopped: "已停止",
  idle: "待开始",
};
