// 文件粘贴冲突对话框：覆盖 / 重命名 / 跳过
import { useUiStore } from "../../stores/uiStore";

export function OverwriteDialog() {
  const overwrite = useUiStore((s) => s.overwrite);
  const resolveOverwrite = useUiStore((s) => s.resolveOverwrite);

  if (!overwrite.open) return null;

  return (
    <div className="modal-mask" onClick={() => resolveOverwrite("skip")}>
      <div
        className="modal"
        onClick={(e) => e.stopPropagation()}
        style={{ width: 420 }}
      >
        <div className="modal-header">{overwrite.title}</div>
        <div
          className="modal-body"
          style={{ color: "var(--fg-secondary)", lineHeight: 1.6, whiteSpace: "pre-wrap" }}
        >
          {overwrite.message}
        </div>
        <div className="modal-footer">
          <button className="btn" onClick={() => resolveOverwrite("skip")}>
            跳过
          </button>
          <button className="btn" onClick={() => resolveOverwrite("rename")}>
            重命名
          </button>
          <button
            className="btn btn-primary"
            onClick={() => resolveOverwrite("overwrite")}
            autoFocus
          >
            覆盖
          </button>
        </div>
      </div>
    </div>
  );
}
