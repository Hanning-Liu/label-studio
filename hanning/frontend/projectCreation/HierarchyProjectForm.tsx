import React, { useEffect, useRef, useState } from "react";
import styles from "./HierarchyProjectForm.module.scss";

const levels = ["房间、门与窗", "功能分区", "占用区域与家具组团", "家具实例"];
type SourceTask = {
  id: number;
  image_name: string;
  annotation_id: number | null;
  version: string | null;
  ready: boolean;
  reason: string;
};
type Sources = {
  projects: { id: number; title: string }[];
  tasks: SourceTask[];
  page: number;
  pages: number;
  count: number;
};
type Props = {
  loadSources: (params: { level: number; project_id?: number; page?: number }) => Promise<Sources>;
  createProject: (body: Record<string, unknown>) => Promise<void>;
  onCancel: () => void;
  onStandard: () => void;
};

export function HierarchyProjectForm({ loadSources, createProject, onCancel, onStandard }: Props) {
  const [level, setLevel] = useState(2);
  const [projectId, setProjectId] = useState("");
  const [taskId, setTaskId] = useState("");
  const [title, setTitle] = useState("");
  const [page, setPage] = useState(1);
  const [refresh, setRefresh] = useState(0);
  const [sources, setSources] = useState<Sources | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const submitting = useRef(false);

  useEffect(() => {
    let current = true;
    setSources(null);
    setTaskId("");
    setError("");
    if (level === 1) {
      setLoading(false);
      return;
    }
    setLoading(true);
    loadSources({ level, ...(projectId ? { project_id: Number(projectId), page } : {}) })
      .then((data) => {
        if (!current) return;
        setSources(data);
        if (!projectId && data.projects.length === 1) setProjectId(String(data.projects[0].id));
        if (data.tasks.length === 1 && data.tasks[0].ready) setTaskId(String(data.tasks[0].id));
      })
      .catch((e) => {
        if (current) setError(e.message || "无法读取来源，请重试。");
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [level, projectId, page, refresh, loadSources]);

  const source = sources?.tasks.find((task) => String(task.id) === taskId);
  const sourceProject = sources?.projects.find((project) => String(project.id) === projectId);
  const suggestedTitle = sourceProject
    ? `${sourceProject.title} · L${level} ${levels[level - 1]}`
    : `L${level} ${levels[level - 1]}`;
  const ready = level === 1 || (!loading && source?.ready);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!ready || submitting.current) return;
    submitting.current = true;
    setSaving(true);
    setError("");
    try {
      await createProject({
        level,
        title: title.trim() || suggestedTitle,
        ...(level > 1
          ? { source_task: source!.id, source_annotation: source!.annotation_id, source_version: source!.version }
          : {}),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "创建失败，请重试。");
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  };

  return (
    <form className={styles.form} onSubmit={submit} aria-label="创建层级标注项目">
      <header>
        <h1>Create Project</h1>
        <p>选择标注层级，自动配置工具和上游参考。</p>
      </header>
      <fieldset disabled={saving} className={styles.levels}>
        <legend>标注层级</legend>
        {levels.map((label, index) => (
          <label key={label} className={level === index + 1 ? styles.active : ""}>
            <input
              type="radio"
              name="level"
              value={index + 1}
              checked={level === index + 1}
              onChange={() => {
                setLevel(index + 1);
                setProjectId("");
                setTaskId("");
                setSources(null);
                setPage(1);
                setTitle("");
              }}
            />
            <strong>L{index + 1}</strong>
            <span>{label}</span>
          </label>
        ))}
      </fieldset>
      <p className={styles.hint}>
        {level === 1
          ? "创建后导入平面图，即可标注房间、门、通道与窗。"
          : `从 L${level - 1} 的已提交标注创建 L${level}，自动引用同一张图片和只读参考；不会代替你完成本层标注。`}
      </p>
      {level > 1 && (
        <>
          <label className={styles.field}>
            上游 L{level - 1} 项目
            <select
              aria-label="上游项目"
              value={projectId}
              disabled={saving || loading}
              onChange={(event) => {
                setProjectId(event.target.value);
                setTaskId("");
                setSources(null);
                setPage(1);
                setTitle("");
              }}
            >
              <option value="">请选择项目</option>
              {sources?.projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.title}
                </option>
              ))}
            </select>
          </label>
          {!loading && sources?.projects.length === 0 && (
            <p role="status">尚无 L{level - 1} 项目。请先创建并完成上一层标注，再回来创建本层。</p>
          )}
          {projectId && (
            <label className={styles.field}>
              来源图片
              <select
                aria-label="来源图片"
                value={taskId}
                disabled={saving || loading}
                onChange={(event) => setTaskId(event.target.value)}
              >
                <option value="">请选择图片</option>
                {sources?.tasks.map((task) => (
                  <option key={task.id} value={task.id}>
                    #{task.id} · {task.image_name || "图片"}
                    {task.ready ? ` · 已提交标注 #${task.annotation_id}` : " · 暂不可用"}
                  </option>
                ))}
              </select>
            </label>
          )}
          {source && !source.ready && (
            <p role="status" className={styles.error}>
              {source.reason}
            </p>
          )}
          {source?.ready && (
            <p className={styles.hint}>
              将使用图片 #{source.id} 的正式标注 #{source.annotation_id}。尚未提交的修改不会带入。
            </p>
          )}
          {projectId && !loading && sources?.count === 0 && <p role="status">该项目尚未导入图片。</p>}
          {sources && sources.pages > 1 && (
            <nav aria-label="来源图片分页" className={styles.actions}>
              <button type="button" disabled={saving || loading || page === 1} onClick={() => setPage(page - 1)}>
                上一页
              </button>
              <span>
                {page} / {sources.pages} 页，共 {sources.count} 张
              </span>
              <button
                type="button"
                disabled={saving || loading || page === sources.pages}
                onClick={() => setPage(page + 1)}
              >
                下一页
              </button>
            </nav>
          )}
        </>
      )}
      {loading && <p role="status">正在检查上游正式标注…</p>}
      <label className={styles.field}>
        项目名称
        <input
          aria-label="项目名称"
          value={title}
          placeholder={suggestedTitle}
          disabled={saving}
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>
      {error && (
        <div role="alert" className={styles.error}>
          {error}
          {level > 1 && (
            <button type="button" disabled={saving} onClick={() => setRefresh(refresh + 1)}>
              刷新来源
            </button>
          )}
        </div>
      )}
      <footer className={styles.actions}>
        <button type="button" disabled={saving} onClick={onStandard}>
          普通项目 / 自定义模板
        </button>
        <span className={styles.spacer} />
        <button type="button" disabled={saving} onClick={onCancel}>
          取消
        </button>
        <button type="submit" className={styles.primary} disabled={saving || !ready}>
          {saving ? "正在创建…" : `创建 L${level} 项目`}
        </button>
      </footer>
    </form>
  );
}
