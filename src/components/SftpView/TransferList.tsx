// 传输队列（可折叠）
import { useState } from "react";
import { formatSize, formatSpeed } from "../../utils/format";
import type { TransferItem } from "../../types";
import "./SftpView.css";

interface Props {
  transfers: TransferItem[];
  onClear: () => void;
  onResume?: (item: TransferItem) => void;
}

export function TransferList({ transfers, onClear, onResume }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  // 聚合进度（所有传输项的整体百分比）
  const agg = transfers.reduce(
    (a, t) => ({ total: a.total + (t.total || 0), done: a.done + (t.transferred || 0) }),
    { total: 0, done: 0 }
  );
  const aggPct = agg.total > 0 ? Math.min(100, (agg.done / agg.total) * 100) : 0;
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
      {!collapsed && agg.total > 0 && (
        <div className="sftp-transfers-aggregate">
          <div
            className="sftp-transfers-aggregate-fill"
            style={{ width: `${aggPct}%` }}
          />
        </div>
      )}
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
              {t.status === "error" && t.canResume && onResume && (
                <button
                  className="btn btn-ghost btn-sm sftp-transfer-resume"
                  title="从断点继续传输"
                  onClick={() => onResume(t)}
                >
                  续传
                </button>
              )}
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
