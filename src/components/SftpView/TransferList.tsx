// 传输队列（可折叠）
import { useState } from "react";
import { formatSize, formatSpeed } from "../../utils/format";
import "./SftpView.css";

export interface TransferItem {
  id: string;
  name: string;
  direction: "upload" | "download";
  transferred: number;
  total: number;
  speed: number;
  status: "running" | "done" | "error" | "cancelled";
  message?: string;
}

interface Props {
  transfers: TransferItem[];
  onClear: () => void;
}

export function TransferList({ transfers, onClear }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  if (transfers.length === 0) return null;

  return (
    <div className={`sftp-transfers ${collapsed ? "collapsed" : ""}`}>
      <div
        className="sftp-transfers-header"
        onClick={() => setCollapsed((c) => !c)}
      >
        <span className="sftp-transfers-chevron">
          <ChevronIcon />
        </span>
        <span>传输队列</span>
        <span style={{ color: "var(--fg-muted)" }}>·</span>
        <span style={{ color: "var(--fg-muted)" }}>{transfers.length} 项</span>
        <div style={{ flex: 1 }} />
        <button
          className="btn btn-ghost btn-sm"
          onClick={(e) => {
            e.stopPropagation();
            onClear();
          }}
        >
          清空
        </button>
      </div>
      <div className="sftp-transfers-list">
        {transfers.map((t) => {
          const percent = t.total > 0 ? (t.transferred / t.total) * 100 : 0;
          return (
            <div className="sftp-transfer-row" key={t.id}>
              <div>
                <div className="sftp-transfer-info">
                  <span style={{ color: t.direction === "upload" ? "var(--accent-violet)" : "var(--accent-blue)" }}>
                    {t.direction === "upload" ? "↑" : "↓"}
                  </span>
                  <span className="sftp-transfer-name" title={t.message}>
                    {t.name}
                  </span>
                  <span className="sftp-transfer-meta">
                    {formatSize(t.transferred)} / {formatSize(t.total)}
                    {t.status === "running" && ` · ${formatSpeed(t.speed)}`}
                    {t.status === "done" && " · 完成"}
                    {t.status === "error" && " · 失败"}
                  </span>
                </div>
                <div className="sftp-transfer-bar">
                  <div
                    className={`sftp-transfer-bar-fill ${t.status}`}
                    style={{ width: `${Math.min(100, percent)}%` }}
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ChevronIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
      <path d="M3 2l4 3-4 3" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
