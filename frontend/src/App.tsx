import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { EMPTY_ENGINE, useWorkspace } from "./hooks/useWorkspace";
import { useUpdater } from "./hooks/useUpdater";
import LoginScreen from "./components/LoginScreen";
import Sidebar from "./components/Sidebar";
import TitleBar from "./components/TitleBar";
import CoursePanel from "./components/CoursePanel";
import TaskList from "./components/TaskList";
import ControlDock from "./components/ControlDock";
import LogDrawer from "./components/LogDrawer";
import StudyCaptchaModal from "./components/StudyCaptchaModal";
import { IconLog, IconRefresh, IconSearch } from "./components/Icons";
import { classNames, matchesTaskFilter, type TaskFilter } from "./utils";

const FILTERS: Array<[TaskFilter, string]> = [
  ["all", "全部"],
  ["todo", "未完成"],
  ["done", "已完成"],
];

export default function App() {
  const ws = useWorkspace();
  const {
    status: updateStatus,
    version: updateVersion,
    progress: updateProgress,
    checkForUpdate,
    installUpdate,
  } = useUpdater(ws.notify);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<TaskFilter>("all");
  const [logOpen, setLogOpen] = useState(false);
  const [busyCourse, setBusyCourse] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [appVersion, setAppVersion] = useState("");

  const tasksRef = useRef(ws.snapshot?.tasks ?? []);
  tasksRef.current = ws.snapshot?.tasks ?? [];

  const course = ws.snapshot?.course ?? null;
  const tasks = ws.snapshot?.tasks ?? [];
  const engine = ws.engine ?? EMPTY_ENGINE;

  // 切课：默认勾选所有未完成视频
  useEffect(() => {
    if (!course) {
      setSelected(new Set());
      return;
    }
    const ids = new Set(tasksRef.current.map((task) => task.id));
    const defaults = new Set(tasksRef.current.filter((task) => !task.completed && ids.has(task.id)).map((task) => task.id));
    setSelected(defaults);
    setQuery("");
    setFilter("all");
  }, [course?.id]);

  // 只有“本轮刚播完”的视频才自动取消勾选；已完成的老视频允许手动勾选补进度
  const prevStatusRef = useRef<Record<string, string | undefined>>({});
  useEffect(() => {
    const prevStatus = prevStatusRef.current;
    const nextStatus: Record<string, string | undefined> = {};
    const justFinished: string[] = [];
    for (const [id, item] of Object.entries(ws.progress)) {
      nextStatus[id] = item.status;
      const before = prevStatus[id];
      if (before && before !== item.status && (item.status === "done" || item.status === "skipped")) {
        justFinished.push(id);
      }
    }
    prevStatusRef.current = nextStatus;
    if (justFinished.length === 0) return;
    setSelected((prev) => {
      if (!justFinished.some((id) => prev.has(id))) return prev;
      const next = new Set(prev);
      for (const id of justFinished) next.delete(id);
      return next;
    });
  }, [ws.progress]);

  // Esc 收起日志抽屉
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setLogOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 启动后静默检查一次更新，有新版才提示
  useEffect(() => {
    if (ws.booting) return;
    void checkForUpdate(true);
  }, [ws.booting, checkForUpdate]);

  // 取当前安装版本，展示在“检查更新”按钮上
  useEffect(() => {
    if (!isTauri()) return;
    void getVersion()
      .then(setAppVersion)
      .catch(() => {
        /* 版本读取失败时不显示，不影响按钮功能 */
      });
  }, []);

  // 首屏渲染完成：撤掉 index.html 里的预置启动屏，再显示窗口并淡入
  useEffect(() => {
    const splash = document.getElementById("boot-splash");
    if (splash) {
      splash.classList.add("is-gone");
      window.setTimeout(() => splash.remove(), 360);
    }
    document.documentElement.classList.add("app-enter");
    if (!isTauri()) return;
    const win = getCurrentWindow();
    void win
      .show()
      .then(() => win.setFocus())
      .catch(() => {
        /* 窗口已可见或环境不支持，忽略即可 */
      });
  }, []);

  const stats = useMemo(() => {
    let done = 0;
    let totalSeconds = 0;
    let studiedSeconds = 0;
    for (const task of tasks) {
      const watched = ws.progress[task.id]?.watched ?? task.studied ?? 0;
      if (matchesTaskFilter(task, "done", "", ws.progress)) done += 1;
      totalSeconds += task.video_sec || 0;
      studiedSeconds += Math.min(watched, task.video_sec || watched);
    }
    return {
      done,
      total: tasks.length,
      totalSeconds,
      studiedSeconds,
      overall: totalSeconds > 0 ? (studiedSeconds / totalSeconds) * 100 : 0,
    };
  }, [tasks, ws.progress]);

  const handleSelectCourse = async (courseId: string) => {
    if (busyCourse) return;
    if (engine.status !== "idle") {
      ws.notify("请先停止当前播放", "error");
      return;
    }
    setBusyCourse(courseId);
    try {
      await ws.selectCourse(courseId);
    } finally {
      setBusyCourse(null);
    }
  };

  const handleStart = async () => {
    setBusy(true);
    try {
      // 跳过条件统一由后端判定：不勾选严格 100% 按平台判定，勾选则按实际看满时长
      await ws.start([...selected]);
    } finally {
      setBusy(false);
    }
  };

  const handlePlayOne = async (taskId: string) => {
    setBusy(true);
    try {
      await ws.start([taskId], true);
    } finally {
      setBusy(false);
    }
  };

  const toggleTask = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleGroup = (ids: string[], select: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (select) next.add(id);
        else next.delete(id);
      }
      return next;
    });

  // 当前关键词 + 筛选条件下可见的任务，列表渲染用的是同一套判断
  const visibleTasks = useMemo(
    () => tasks.filter((task) => matchesTaskFilter(task, filter, query, ws.progress)),
    [tasks, filter, query, ws.progress],
  );

  // 全选当前筛选结果（含已完成的，可用来补进度）
  const selectVisible = () =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const task of visibleTasks) next.add(task.id);
      return next;
    });

  const updateLabel =
    updateStatus === "checking"
      ? "检查中…"
      : updateStatus === "downloading"
        ? `下载 ${updateProgress}%`
        : updateStatus === "installing"
          ? "正在重启…"
          : updateStatus === "available"
            ? `更新到 v${updateVersion}`
            : "检查更新";

  const authenticated = Boolean(ws.snapshot?.authenticated);
  const note = course ? `${tasks.length} 个视频 · 已选 ${selected.size}` : "从左侧选择一门课程";

  // 标题栏右侧动作：检查更新 / 刷新进度 / 运行日志
  const toolbar = (
    <>
      <button
        className={classNames("btn btn-quiet", updateStatus === "available" && "on")}
        disabled={updateStatus === "checking" || updateStatus === "downloading" || updateStatus === "installing"}
        onClick={() => void (updateStatus === "available" ? installUpdate() : checkForUpdate())}
      >
        <IconRefresh size={15} />
        {updateLabel}
        {updateStatus !== "available" && appVersion && <em>v{appVersion}</em>}
      </button>
      {course && (
        <button className="btn btn-quiet" onClick={() => void ws.refreshProgress()}>
          <IconRefresh size={15} />
          刷新进度
        </button>
      )}
      <button
        className={classNames("btn btn-quiet", logOpen && "on")}
        onClick={() => setLogOpen((prev) => !prev)}
      >
        <IconLog size={15} />
        运行日志
      </button>
    </>
  );

  let content: ReactNode;

  if (ws.booting) {
    content = (
      <div className="boot">
        <div className="boot-bg" aria-hidden />
        <div className="boot-card is-busy" role="status" aria-live="polite">
          <img className="boot-logo" src="/frog.png" alt="" />
          <div className="boot-copy">
            <strong>正在连接本地服务</strong>
            <span>首次启动需要几秒，正在唤起本地学习引擎</span>
          </div>
          <span className="spinner" aria-hidden />
        </div>
      </div>
    );
  } else if (ws.bootError) {
    content = (
      <div className="boot">
        <div className="boot-bg" aria-hidden />
        <div className="boot-stack">
          <div className="boot-card">
            <img className="boot-logo" src="/frog.png" alt="" />
            <div className="boot-copy">
              <strong>后端没有响应</strong>
              <span className="boot-detail">{ws.bootError}</span>
            </div>
          </div>
          <button className="btn btn-primary" onClick={() => void ws.bootstrap()}>
            重新连接
          </button>
        </div>
      </div>
    );
  } else if (!ws.snapshot?.authenticated) {
    content = <LoginScreen onAuthed={ws.refresh} dataDir={ws.snapshot?.data_dir} />;
  } else {
    content = (
      <div className="shell">
        <Sidebar
          profile={ws.snapshot.profile}
          courses={ws.snapshot.courses}
          activeId={course?.id}
          busyId={busyCourse}
          onSelect={(id) => void handleSelectCourse(id)}
          onRefreshCourses={() => void ws.reloadCourses()}
          onLogout={() => void ws.logout()}
        />

        <main className="board">
          <div className="board-scroll">
            {!course ? (
              <section className="vacant">
                <p className="vacant-index">课程 / 01</p>
                <h1>
                  先选一门课
                  <br />
                  再把时间交还给自己
                </h1>
                <p className="vacant-copy">
                  左侧列出你名下的共享课。选中课程后，这里会展开章节目录、每节的时长与真实学习进度，
                  勾选需要完成的视频即可排队播放。
                </p>
                <ul className="vacant-list">
                  <li>
                    <span>01</span> 单集播放或整章排队，顺序可随时停止
                  </li>
                  <li>
                    <span>02</span> 进度每秒回传，关闭窗口后仍以服务端为准
                  </li>
                  <li>
                    <span>03</span> 账号与 Cookie 只写在本机数据目录
                  </li>
                </ul>
              </section>
            ) : (
              <>
                <CoursePanel course={course} stats={stats} />

                <section className="ledger">
                  <div className="ledger-tools">
                    <label className="search">
                      <IconSearch size={15} />
                      <input
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder="搜索章节或视频"
                        spellCheck={false}
                      />
                    </label>

                    <div className="filters" role="tablist">
                      {FILTERS.map(([value, label]) => (
                        <button
                          key={value}
                          role="tab"
                          aria-selected={filter === value}
                          className={classNames("filter", filter === value && "active")}
                          onClick={() => setFilter(value)}
                        >
                          {label}
                          <em>
                            {value === "all"
                              ? tasks.length
                              : tasks.filter((task) => matchesTaskFilter(task, value, "", ws.progress)).length}
                          </em>
                        </button>
                      ))}
                    </div>

                    <div className="ledger-actions">
                      <button className="link-btn" onClick={selectVisible} disabled={visibleTasks.length === 0}>
                        全选
                      </button>
                      <button className="link-btn" onClick={() => setSelected(new Set())}>
                        清空
                      </button>
                    </div>
                  </div>

                  <TaskList
                    tasks={tasks}
                    chapters={ws.snapshot.chapters}
                    progress={ws.progress}
                    selected={selected}
                    query={query}
                    filter={filter}
                    engineStatus={engine.status}
                    busy={busy}
                    onToggle={toggleTask}
                    onToggleGroup={toggleGroup}
                    onPlayOne={(id) => void handlePlayOne(id)}
                  />
                </section>
              </>
            )}
          </div>

          {course && (
            <ControlDock
              engine={engine}
              speed={ws.speed}
              strictFull={ws.strictFull}
              autoSolve={ws.autoSolve}
              currentCompleted={Boolean(tasks.find((task) => task.id === engine.current.task_id)?.completed)}
              selectedCount={selected.size}
              totalCount={tasks.length}
              busy={busy}
              onSpeed={ws.setSpeed}
              onStrictFull={ws.setStrictFull}
              onAutoSolve={ws.setAutoSolve}
              onStart={() => void handleStart()}
              onPause={() => void ws.control("pause")}
              onResume={() => void ws.control("resume")}
              onStop={() => void ws.control("stop")}
            />
          )}
        </main>
      </div>
    );
  }

  return (
    <div className="app">
      <TitleBar connection={ws.connection} note={authenticated ? note : undefined}>
        {authenticated ? toolbar : null}
      </TitleBar>

      <div className="app-body">{content}</div>

      <LogDrawer open={logOpen} logs={ws.logs} onClose={() => setLogOpen(false)} />

      {ws.studyCaptcha && !ws.captchaHidden && (
        <StudyCaptchaModal
          payload={ws.studyCaptcha.payload}
          task={ws.studyCaptcha.task}
          onSubmit={ws.submitStudyCaptcha}
          onRefresh={ws.refreshStudyCaptcha}
          onDismiss={ws.hideStudyCaptcha}
          onRetry={ws.confirmStudyCaptcha}
          auto={ws.captchaAuto}
          onAutoStop={ws.stopStudyCaptchaAuto}
        />
      )}

      {ws.studyCaptcha && ws.captchaHidden && (
        <button className="captcha-fab" onClick={ws.showStudyCaptcha} aria-label="人机验证待完成，点击展开">
          人机验证待完成
        </button>
      )}

      {ws.toast && (
        <div className={classNames("toast", ws.toast.level)} role="status" aria-live="polite">
          {ws.toast.text}
        </div>
      )}
    </div>
  );
}
