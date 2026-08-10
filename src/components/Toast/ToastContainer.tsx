// Toast 容器
import { useToastStore } from "../../stores/toastStore";
import "./Toast.css";

export function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts);
  const remove = useToastStore((s) => s.remove);

  return (
    <div className="toast-container">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          <div className="toast-icon">
            {t.kind === "success" ? "✓" : t.kind === "error" ? "✕" : t.kind === "warn" ? "!" : "i"}
          </div>
          <div className="toast-body">
            <div className="toast-title">{t.title}</div>
            {t.message && <div className="toast-message">{t.message}</div>}
          </div>
          <button className="toast-close" onClick={() => remove(t.id)}>
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      ))}
    </div>
  );
}
