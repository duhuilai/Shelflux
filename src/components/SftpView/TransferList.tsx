// 传输队列（可折叠）
import { useState } from "react";
import { formatSize, formatSpeed, basename } from "../../utils/format";
import type { TransferItem } from "../../types";
import "./SftpView.css";

interface Props {
  transfers: TransferItem[];
  onClear: () => void;
  onResume?: (item: TransferItem) => void;
  onRetryAll?: () => void;
  onPauseAll?: () => void;
}

export function TransferList({ transfers, onClear, onResume, onRetryAll, onPauseAll }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  // 聚合进度：取各项完成百分比的均值。
  // 注意不能直接累加 transferred/total 再相除——删除项的单位是「项数」、
  // 传输项的单位是「字节」，混合相加会得到无意义的比例。
  const hasDelete = transfers.some((t) => t.direction === "delete");
  const aggPct =
    transfers.length > 0
      ? transfers.reduce(
          (sum, t) =>
            sum + (t.total > 0 ? Math.min(100, (t.transferred / t.total) * 100) : 0),
          0
        ) / transfers.length
      : 0;
  const erroredCount = transfers.filter((t) => t.status === "error" && t.canResume).length;
  const runningCount = transfers.filter((t) => t.status === "running").length;
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
        <span>{hasDelete ? "任务队列" : "传输队列"}</span>
        <span style={{ color: "var(--fg-muted)" }}>·</span>
        <span style={{ color: "var(--fg-muted)" }}>{transfers.length} 项</span>
        <div style={{ flex: 1 }} />
        {runningCount > 0 && onPauseAll && (
          <button
            className="btn btn-ghost btn-sm"
            title="暂停全部进行中的传输"
            onClick={(e) => {
              e.stopPropagation();
              onPauseAll();
            }}
          >
            全部暂停
          </button>
        )}
        {erroredCount > 0 && onRetryAll && (
          <button
            className="btn btn-ghost btn-sm"
            title="重试全部失败且可续传的任务"
            onClick={(e) => {
              e.stopPropagation();
              onRetryAll();
            }}
          >
            全部重试
          </button>
        )}
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
      {!collapsed && transfers.length > 0 && (
        <div className="sftp-transfers-aggregate">
          <div
            className="sftp-transfers-aggregate-fill"
            style={{ width: `${aggPct}%` }}
          />
        </div>
      )}
      <div className="sftp-transfers-list">
        {transfers.map((t) => {
          const isDelete = t.direction === "delete";
          const percent = t.total > 0 ? (t.transferred / t.total) * 100 : 0;
          return (
            <div className="sftp-transfer-row" key={t.id}>
              <div>
                <div className="sftp-transfer-info">
                  <span
                    style={{
                      color: isDelete
                        ? "var(--color-error)"
                        : t.direction === "upload"
                          ? "var(--accent-violet)"
                          : "var(--accent-blue)",
                    }}
                  >
                    {isDelete ? <TrashMiniIcon /> : t.direction === "upload" ? "↑" : "↓"}
                  </span>
                  <span className="sftp-transfer-name" title={t.message}>
                    {t.name}
                  </span>
                  <span className="sftp-transfer-meta">
                    {isDelete
                      ? `${t.transferred} / ${t.total} 项`
                      : `${formatSize(t.transferred)} / ${formatSize(t.total)}`}
                    {t.status === "running" &&
                      (isDelete ? " · 删除中" : ` · ${formatSpeed(t.speed)}`)}
                    {t.status === "done" && " · 完成"}
                    {t.status === "error" && " · 失败"}
                  </span>
                </div>
                <div className="sftp-transfer-bar">
                  <div
                    className={`sftp-transfer-bar-fill ${t.status} ${isDelete ? "delete" : ""}`}
                    style={{ width: `${Math.min(100, percent)}%` }}
                  />
                </div>
                {/* 删除任务：实时显示当前正在删除的文件 */}
                {isDelete && t.status === "running" && t.message && (
                  <div className="sftp-transfer-current" title={t.message}>
                    {basename(t.message)}
                  </div>
                )}
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

function TrashMiniIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
      <path
        d="M1.5 2.5h7M4 2.5V1.5h2v1M2.5 2.5l.5 6h4l.5-6"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
      <path d="M3 2l4 3-4 3" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
