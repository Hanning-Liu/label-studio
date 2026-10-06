import { useState } from "react";
import { Modal } from "antd";
import { FURNITURE_TYPE_GROUPS, normalizeFurnitureName } from "@hanning/frontend/domain/catalog";

export async function createFurnitureCategory(item, label, group) {
  const reason = item.furnitureInstanceOperationBlockReason?.();
  if (reason) throw new Error(reason);
  const annotation = item.annotation;
  await annotation.saveDraftImmediatelyWithResults();
  if (item.annotation !== annotation) throw new Error("标注已切换，请重试");
  const csrf = document.cookie
    .split("; ")
    .find((v) => v.startsWith("csrftoken="))
    ?.split("=")
    .slice(1)
    .join("=");
  const projectId =
    annotation.store.project?.id ||
    annotation.store.task?.project ||
    Number(window.location.pathname.match(/\/projects\/(\d+)/)?.[1]);
  const response = await fetch("/api/projects/furniture-catalog/", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-CSRFToken": decodeURIComponent(csrf || "") },
    body: JSON.stringify({ label: normalizeFurnitureName(label), group, project_id: projectId }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.detail || JSON.stringify(data));
  return data.category;
}

export function CreateFurnitureCategory({ item, name, onClose, onCreated }) {
  const [group, setGroup] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Modal
      open
      title={`创建家具类别“${name}”`}
      okText="创建并刷新类别"
      cancelText="取消"
      confirmLoading={busy}
      closable={!busy}
      maskClosable={!busy}
      cancelButtonProps={{ disabled: busy }}
      okButtonProps={{ disabled: !group }}
      onCancel={() => {
        if (!busy) onClose();
      }}
      onOk={async () => {
        if (busy) return;
        setBusy(true);
        setError("");
        try {
          const entry = await createFurnitureCategory(item, name, group);
          onCreated(entry);
        } catch (e) {
          setError(e.message);
          setBusy(false);
        }
      }}
    >
      <p>供当前工作区所有 L4 项目使用。先保存当前草稿，创建成功后刷新页面。</p>
      <label>
        所属大类{" "}
        <select
          aria-label="新家具类别所属大类"
          value={group}
          disabled={busy}
          onChange={(e) => setGroup(e.target.value)}
        >
          <option value="">请选择大类</option>
          {FURNITURE_TYPE_GROUPS.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
      </label>
      {error && <p role="alert">{error}</p>}
    </Modal>
  );
}
