import type { CSSProperties } from "react";
import type { CourseInfo } from "../types";
import { formatDuration } from "../utils";

interface Stats {
  done: number;
  total: number;
  totalSeconds: number;
  studiedSeconds: number;
  overall: number;
}

interface Props {
  course: CourseInfo;
  stats: Stats;
}

export default function CoursePanel({ course, stats }: Props) {
  const percent = Math.max(0, Math.min(100, stats.overall));
  const meta = [course.term, course.school].filter(Boolean).join(" / ") || "共享课";

  return (
    <section className="course-panel">
      <div className="course-panel-top">
        <div className="course-ident">
          <p className="panel-kicker">当前课程</p>
          <h1 className="course-title">{course.name}</h1>
          <p className="course-meta">{meta}</p>
        </div>

        <div className="course-figure">
          <strong>
            {percent.toFixed(1)}
            <span>%</span>
          </strong>
          <p>已学习时长占比</p>
        </div>
      </div>

      <div className="ruler" style={{ "--p": `${percent}%` } as CSSProperties}>
        <div className="ruler-ticks" aria-hidden />
        <div className="ruler-fill" />
        <div className="ruler-needle" />
      </div>

      <div className="ruler-scale" aria-hidden>
        <span>0</span>
        <span>25</span>
        <span>50</span>
        <span>75</span>
        <span>100</span>
      </div>

      <dl className="course-stats">
        <div>
          <dt>视频</dt>
          <dd className="num">{stats.total}</dd>
        </div>
        <div>
          <dt>已完成</dt>
          <dd className="num">{stats.done}</dd>
        </div>
        <div>
          <dt>已学习</dt>
          <dd className="num">{formatDuration(stats.studiedSeconds)}</dd>
        </div>
        <div>
          <dt>课程总时长</dt>
          <dd className="num">{formatDuration(stats.totalSeconds)}</dd>
        </div>
      </dl>
    </section>
  );
}
