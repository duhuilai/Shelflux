// 通用文本输入对话框（替代 window.prompt，兼容 Tauri WebView / macOS）
import { useEffect, useRef, useState } from "react";
import { useUiStore } from "../../stores/uiStore";

export function PromptDialog() {
  const prompt = useUiStore((s) => s.prompt);
  const resolvePrompt = useUiStore((s) => s.resolvePrompt);
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (prompt.open) {
      setValue(prompt.defaultValue || "");
      // 延迟到下一帧再聚焦，确保元素已渲染
      const t = setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 0);
      return () => clearTimeout(t);
    }
  }, [prompt.open]);

  if (!prompt.open) return null;

  const submit = () => resolvePrompt(value.trim());
  const cancel = () => resolvePrompt(null);

  return (
    <div className="modal-mask" onClick={cancel}>
      <div
        className="modal"
        onClick={(e) => e.stopPropagation()}
        style={{ width: 400 }}
      >
        <div className="modal-header">{prompt.title}</div>
        <div
          className="modal-body"
          style={{ color: "var(--fg-secondary)", lineHeight: 1.6 }}
        >
          {prompt.message && (
            <div style={{ marginBottom: 10, fontSize: 13 }}>{prompt.message}</div>
          )}
          <input
            ref={inputRef}
            className="modal-input"
            value={value}
            placeholder={prompt.placeholder}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
              if (e.key === "Escape") cancel();
            }}
          />
        </div>
        <div className="modal-footer">
          <button className="btn" onClick={cancel}>
            {prompt.cancelText}
          </button>
          <button className="btn btn-primary" onClick={submit} autoFocus>
            {prompt.confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
