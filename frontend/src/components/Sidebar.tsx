import { useEffect, useMemo, useState } from "react";
import type { Course, Profile } from "../types";
import { classNames } from "../utils";
import { IconLogout, IconRefresh, IconSearch } from "./Icons";

interface Props {
  profile: Profile | null;
  courses: Course[];
  activeId?: string;
  busyId?: string | null;
  onSelect: (id: string) => void;
  onRefreshCourses: () => void;
  onLogout: () => void;
}

function Avatar({ name, src }: { name?: string; src?: string }) {
  const [broken, setBroken] = useState(false);

  useEffect(() => setBroken(false), [src]);

  if (!src || broken) {
    return <span className="avatar">{name?.slice(0, 1) || "?"}</span>;
  }

  return (
    <img
      className="avatar"
      src={src}
      alt=""
      referrerPolicy="no-referrer"
      loading="eager"
      onError={() => setBroken(true)}
    />
  );
}

export default function Sidebar({
  profile,
  courses,
  activeId,
  busyId,
  onSelect,
  onRefreshCourses,
  onLogout,
}: Props) {
  const [keyword, setKeyword] = useState("");

  const filtered = useMemo(() => {
    const query = keyword.trim().toLowerCase();
    if (!query) return courses;
    return courses.filter(
      (course) =>
        course.name.toLowerCase().includes(query) ||
        (course.school || "").toLowerCase().includes(query) ||
        (course.term || "").toLowerCase().includes(query),
    );
  }, [courses, keyword]);

  return (
    <aside className="rail">
      <div className="rail-profile">
        <Avatar name={profile?.name} src={profile?.avatar} />
        <div className="rail-profile-text">
          <strong title={profile?.name}>{profile?.name || "未登录"}</strong>
          <small>
            智慧树助手
            <i />
            <span title={profile?.username}>{profile?.username || "—"}</span>
          </small>
        </div>
        <button className="rail-icon" onClick={onLogout} title="退出登录" aria-label="退出登录">
          <IconLogout size={16} />
        </button>
      </div>

      <div className="rail-label">
        <span>我的课程</span>
        <em>{courses.length}</em>
        <button className="rail-icon" onClick={onRefreshCourses} title="刷新课程列表" aria-label="刷新课程列表">
          <IconRefresh size={14} />
        </button>
      </div>

      <label className="rail-search">
        <IconSearch size={15} />
        <input
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder="搜索课程"
          spellCheck={false}
        />
      </label>

      <div className="rail-courses">
        {filtered.length === 0 && (
          <p className="rail-empty">{courses.length === 0 ? "暂无课程，点击右上角刷新" : "没有匹配的课程"}</p>
        )}
        {filtered.map((course) => (
          <button
            key={course.id}
            className={classNames("course-row", activeId === course.id && "active")}
            onClick={() => onSelect(course.id)}
            // 加载课程期间禁用全部行：并发切换会让先后返回的详情互相覆盖
            disabled={Boolean(busyId)}
            title={course.name}
          >
            <span className="course-rule" />
            <span className="course-body">
              <strong>{course.name}</strong>
              <small>{[course.term, course.school].filter(Boolean).join(" / ") || "共享课"}</small>
            </span>
            {busyId === course.id && <span className="spinner small" />}
          </button>
        ))}
      </div>
    </aside>
  );
}
