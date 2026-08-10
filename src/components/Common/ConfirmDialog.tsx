// 通用确认对话框
import { useUiStore } from "../../stores/uiStore";

export function ConfirmDialog() {
  const confirm = useUiStore((s) => s.confirm);
  const resolveConfirm = useUiStore((s) => s.resolveConfirm);

  if (!confirm.open) return null;

  return (
    <div className="modal-mask" onClick={() => resolveConfirm(false)}>
      <div
        className="modal"
        onClick={(e) => e.stopPropagation()}
        style={{ width: 400 }}
      >
        <div className="modal-header">
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {confirm.danger && (
              <span
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: "50%",
                  background: "rgba(247, 118, 142, 0.18)",
                  color: "var(--color-error)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 14,
                }}
              >
                !
              </span>
            )}
            {confirm.title}
          </span>
        </div>
        <div
          className="modal-body"
          style={{ color: "var(--fg-secondary)", lineHeight: 1.6, whiteSpace: "pre-wrap" }}
        >
          {confirm.message}
        </div>
        <div className="modal-footer">
          <button className="btn" onClick={() => resolveConfirm(false)}>
            {confirm.cancelText}
          </button>
          <button
            className={`btn ${confirm.danger ? "btn-danger" : "btn-primary"}`}
            onClick={() => resolveConfirm(true)}
            autoFocus
          >
            {confirm.confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
