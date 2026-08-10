import { useState, useEffect, useMemo, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

interface OpenWithApp {
  name: string;
  path: string;
}

interface Props {
  fileName: string;
  extension: string;
  /** 本地文件路径（已下载到临时目录，或本地文件本身） */
  filePath: string;
  /** 当前已在设置里保存的默认程序路径（用于预选中） */
  defaultApp?: string;
  /** 勾选"始终用此程序"时回调，由父组件写入设置 */
  onAlwaysUse?: (appPath: string) => void;
  onClose: () => void;
  onError?: (msg: string) => void;
}

export function OpenWithModal({
  fileName,
  extension,
  filePath,
  defaultApp,
  onAlwaysUse,
  onClose,
  onError,
}: Props) {
  const [apps, setApps] = useState<OpenWithApp[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<OpenWithApp | null>(null);
  const [always, setAlways] = useState(false);
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState(false);

  useEffect(() => {
    invoke<OpenWithApp[]>("get_open_with_apps", { extension })
      .then((list) => {
        setApps(list);
        const d = list.find((a) => a.path === defaultApp);
        setSelected(d || list[0] || null);
      })
      .catch(() => setApps([]))
      .finally(() => setLoading(false));
  }, [extension, defaultApp]);

  const filtered = useMemo(() => {
    if (!query) return apps;
    const q = query.toLowerCase();
    return apps.filter(
      (a) => a.name.toLowerCase().includes(q) || a.path.toLowerCase().includes(q)
    );
  }, [apps, query]);

  const handleBrowse = useCallback(async () => {
    try {
      const isMac = navigator.platform?.startsWith("Mac") || false;
      const picked = await open({
        title: "选择程序",
        filters: [
          {
            name: "可执行程序",
            extensions: isMac ? ["app"] : ["exe"],
          },
        ],
      });
      if (picked && typeof picked === "string") {
        const base = picked.split(/[\\/]/).pop() || picked;
        const app: OpenWithApp = {
          name: base.replace(/\.app$/i, "").replace(/\.exe$/i, ""),
          path: picked,
        };
        setApps((prev) => [...prev, app]);
        setSelected(app);
      }
    } catch {
      /* 用户取消或不支持 */
    }
  }, []);

  const handleConfirm = useCallback(async () => {
    if (!selected || opening) return;
    setOpening(true);
    try {
      if (always && onAlwaysUse) onAlwaysUse(selected.path);
      await invoke("open_with_program", { filePath, programPath: selected.path });
      onClose();
    } catch (e: any) {
      onError?.(e?.toString?.() || String(e));
      setOpening(false);
    }
  }, [selected, opening, always, onAlwaysUse, filePath, onClose, onError]);

  return (
    <div className="modal-overlay active" onClick={onClose}>
      <div
        className="modal open-with-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="open-with-header">打开方式 — {fileName}</div>

        <div className="open-with-search">
          <input
            autoFocus
            className="modal-input"
            placeholder="搜索程序..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && selected) handleConfirm();
            }}
          />
        </div>

        <div className="open-with-list">
          {loading && <div className="open-with-empty">加载中…</div>}
          {!loading && filtered.length === 0 && (
            <div className="open-with-empty">
              未找到程序，点击「浏览」手动选择可执行文件
            </div>
          )}
          {filtered.map((app) => (
            <div
              key={app.path}
              className={`open-with-item ${
                selected?.path === app.path ? "selected" : ""
              }`}
              onClick={() => setSelected(app)}
              onDoubleClick={() => {
                setSelected(app);
                handleConfirm();
              }}
            >
              <span className="open-with-icon">▦</span>
              <span className="open-with-name" title={app.name}>
                {app.name}
              </span>
              <span className="open-with-path" title={app.path}>
                {app.path}
              </span>
            </div>
          ))}
        </div>

        <label className="open-with-always">
          <input
            type="checkbox"
            checked={always}
            onChange={(e) => setAlways(e.target.checked)}
          />
          始终用此程序打开 {extension ? `.${extension}` : "此类"} 文件
        </label>

        <div className="open-with-footer">
          <button className="open-with-btn" onClick={handleBrowse}>
            浏览…
          </button>
          <span className="spacer" />
          <button className="open-with-btn" onClick={onClose}>
            取消
          </button>
          <button
            className="open-with-btn primary"
            disabled={!selected || opening}
            onClick={handleConfirm}
          >
            打开
          </button>
        </div>
      </div>
    </div>
  );
}
