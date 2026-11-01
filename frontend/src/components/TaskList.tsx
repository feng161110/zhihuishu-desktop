import { useMemo, useState } from "react";
import type { Chapter, EngineState, Task, TaskProgress } from "../types";
import {
  clamp,
  classNames,
  formatDuration,
  matchesTaskFilter,
  STATUS_TEXT,
  type TaskFilter,
} from "../utils";
import { IconCheck, IconChevron, IconMinus, IconPlay } from "./Icons";

interface Props {
  tasks: Task[];
  chapters: Chapter[];
  progress: Record<string, TaskProgress>;
  selected: Set<string>;
  query: string;
  filter: TaskFilter;
  engineStatus: EngineState["status"];
  /** 有请求在飞时禁掉行内播放，避免连点触发两次 /api/engine/start */
  busy?: boolean;
  onToggle: (id: string) => void;
  onToggleGroup: (ids: string[], select: boolean) => void;
  onPlayOne: (id: string) => void;
}

function Checkbox({
  checked,
  mixed,
  onClick,
  disabled,
}: {
  checked: boolean;
  mixed?: boolean;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={classNames("check", (checked || mixed) && "on")}
      onClick={onClick}
      disabled={disabled}
      aria-pressed={checked}
      aria-label={checked ? "取消选择" : "选择"}
    >
      {mixed ? <IconMinus size={11} /> : checked ? <IconCheck size={11} /> : null}
    </button>
  );
}

export default function TaskList({
  tasks,
  chapters,
  progress,
  selected,
  query,
  filter,
  engineStatus,
  busy = false,
  onToggle,
  onToggleGroup,
  onPlayOne,
}: Props) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const taskMap = useMemo(() => {
    const map: Record<string, Task> = {};
    for (const task of tasks) map[task.id] = task;
    return map;
  }, [tasks]);

  const groups = useMemo(() => {
    const match = (task: Task) => matchesTaskFilter(task, filter, query, progress);

    const result: Array<{ name: string; tasks: Task[] }> = chapters
      .map((chapter) => ({
        name: chapter.name,
        tasks: chapter.task_ids
          .map((id) => taskMap[id])
          .filter((task): task is Task => Boolean(task) && match(task)),
      }))
      .filter((chapter) => chapter.tasks.length > 0);

    const grouped = new Set(chapters.flatMap((chapter) => chapter.task_ids));
    const rest = tasks.filter((task) => !grouped.has(task.id) && match(task));
    if (rest.length > 0) result.push({ name: "其他", tasks: rest });
    return result;
  }, [chapters, tasks, taskMap, query, filter, progress]);

  const locked = engineStatus === "running" || engineStatus === "paused" || engineStatus === "stopping";

  if (groups.length === 0) {
    return (
      <div className="ledger-empty">
        <p>这里没有符合条件的视频</p>
        <span>换一个筛选条件，或清空搜索关键词</span>
      </div>
    );
  }

  return (
    <div className="ledger-body">
      <div className="task-head" aria-hidden>
        <span />
        <span>视频</span>
        <span>进度</span>
        <span>时长</span>
        <span />
      </div>

      {groups.map((group) => {
        const ids = group.tasks.map((task) => task.id);
        const selectedCount = ids.filter((id) => selected.has(id)).length;
        const doneCount = group.tasks.filter((task) => task.completed || progress[task.id]?.status === "done").length;
        const isCollapsed = Boolean(collapsed[group.name]);

        return (
          <section className="chapter" key={group.name}>
            <header className="chapter-head">
              <Checkbox
                checked={ids.length > 0 && selectedCount === ids.length}
                mixed={selectedCount > 0 && selectedCount < ids.length}
                onClick={() => onToggleGroup(ids, selectedCount < ids.length)}
                disabled={ids.length === 0}
              />
              <button
                className={classNames("chapter-toggle", isCollapsed && "collapsed")}
                onClick={() => setCollapsed((prev) => ({ ...prev, [group.name]: !prev[group.name] }))}
                aria-expanded={!isCollapsed}
              >
                <IconChevron size={13} />
                <span>{group.name}</span>
              </button>
              <span className="chapter-count">
                {doneCount}/{group.tasks.length}
              </span>
            </header>

            {!isCollapsed &&
              group.tasks.map((task) => {
                const item = progress[task.id];
                const status = item?.status ?? (task.completed ? "done" : "pending");
                const watched = item?.watched ?? task.studied;
                const total = item?.total ?? task.video_sec;
                const percent = total > 0 ? clamp((watched / total) * 100, 0, 100) : task.completed ? 100 : 0;
                const playing = status === "playing";

                return (
                  <article
                    className={classNames("task-row", selected.has(task.id) && "selected", playing && "playing")}
                    key={task.id}
                  >
                    <Checkbox checked={selected.has(task.id)} onClick={() => onToggle(task.id)} />

                    <div className="task-main">
                      <h3 title={task.name}>{task.name}</h3>
                      <p className={classNames("task-state", status)}>
                        <i />
                        {STATUS_TEXT[status] || status}
                        {task.completed && status !== "done" && (
                          <span className="task-done-tag" title="平台侧已判定完成，当前是在补进度">
                            已完成
                          </span>
                        )}
                      </p>
                    </div>

                    <div className="task-meter">
                      <span
                        className="meter"
                        role="progressbar"
                        aria-label="本节学习进度"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={Math.round(percent)}
                      >
                        <i style={{ width: `${percent}%` }} />
                      </span>
                      <span className="meter-num">{percent.toFixed(0)}%</span>
                    </div>

                    <span className="task-time">
                      <b>{formatDuration(watched)}</b>
                      <em>{formatDuration(total)}</em>
                    </span>

                    <button
                      className="row-play"
                      title="只播放这一节"
                      aria-label={`只播放：${task.name}`}
                      onClick={() => onPlayOne(task.id)}
                      disabled={busy || locked || total <= 0}
                    >
                      <IconPlay size={12} />
                    </button>
                  </article>
                );
              })}
          </section>
        );
      })}
    </div>
  );
}
