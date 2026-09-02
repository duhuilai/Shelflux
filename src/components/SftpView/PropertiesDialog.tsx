// 远端/本地文件「属性」详情面板
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { FileEntry, Server } from "../../types";

interface Props {
  item: FileEntry;
  side: "local" | "remote";
  server?: Server;
  onClose: () => void;
}

/** 权限数字 -> 八进制（如 0o755 => "0755"） */
function permOctal(p?: number): string {
  if (p == null) return "—";
  return "0" + (p & 0o777).toString(8).padStart(3, "0");
}

/** 权限数字 -> 类 ls 的 rwx 字符串 */
function permHuman(p?: number): string {
  if (p == null) return "—";
  const f = (bit: number, c: string) => (p & bit ? c : "-");
  const o = (base: number) =>
    f(base << 2, "r") + f(base << 1, "w") + f(base, "x");
  return `${o(0o100)}${o(0o010)}${o(0o001)}`;
}

function fmtDate(secs?: number): string {
  if (secs == null) return "—";
  const d = new Date(secs * 1000);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}

interface Row {
  label: string;
  value: string;
}

export function PropertiesDialog({ item, side, server, onClose }: Props) {
  const [info, setInfo] = useState<FileEntry | null>(null);
  const [linkTarget, setLinkTarget] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        let data: FileEntry | null = null;
        if (side === "remote" && server) {
          data = await invoke<FileEntry | null>("sftp_stat", {
            server,
            path: item.path,
          });
          if (item.isSymlink) {
            try {
              const t = await invoke<string>("sftp_readlink", {
                server,
                path: item.path,
              });
              if (alive) setLinkTarget(t);
            } catch {
              /* 读取链接目标失败可以忽略 */
            }
          }
        } else {
          data = await invoke<FileEntry | null>("local_stat", {
            path: item.path,
          });
        }
        if (alive) setInfo(data ?? item);
      } catch {
        if (alive) setInfo(item);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [item.path, item.isSymlink, side, server]);

  const rows: Row[] = [];
  if (info) {
    rows.push({ label: "名称", value: info.name });
    rows.push({ label: "路径", value: info.path });
    rows.push({
      label: "类型",
      value: info.isSymlink
        ? "符号链接"
        : info.kind === "dir"
        ? "文件夹"
        : "文件",
    });
    rows.push({ label: "大小", value: info.size > 0 ? formatBytes(info.size) : "0 B" });
    rows.push({ label: "权限", value: `${permOctal(info.permissions)} (${permHuman(info.permissions)})` });
    rows.push({
      label: "属主 / 组",
      value:
        info.uid != null || info.gid != null
          ? `${info.uid ?? "?"} / ${info.gid ?? "?"}`
          : "—",
    });
    rows.push({ label: "修改时间", value: fmtDate(info.modified) });
  }
  if (linkTarget != null) {
    rows.push({ label: "链接目标", value: linkTarget });
  }

  return (
    <div className="modal-mask" onMouseDown={onClose}>
      <div className="modal props-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>属性</span>
          <button className="modal-close" onClick={onClose} title="关闭">
            ×
          </button>
        </div>
        <div className="modal-body">
          {loading ? (
            <div className="props-loading">加载中…</div>
          ) : (
            <div className="props-grid">
              {rows.map((r) => (
                <div className="props-row" key={r.label}>
                  <div className="props-label">{r.label}</div>
                  <div className="props-value" title={r.value}>
                    {r.value}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="modal-btn modal-btn-secondary" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}
