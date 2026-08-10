// 新建页签时弹出 - 选择服务器
import { useState, useMemo } from "react";
import { useServerStore } from "../../stores/serverStore";
import { useTabStore } from "../../stores/tabStore";
import { useUiStore } from "../../stores/uiStore";
import type { Server, TabKind } from "../../types";
import { toast } from "../../stores/toastStore";

interface Props {
  onClose: () => void;
}

export function ServerPicker({ onClose }: Props) {
  const groups = useServerStore((s) => s.groups);
  const servers = useServerStore((s) => s.servers);
  const openTab = useTabStore((s) => s.openTab);
  const openServerForm = useUiStore((s) => s.openServerForm);
  const [search, setSearch] = useState("");
  const [activeServer, setActiveServer] = useState<Server | null>(null);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return servers;
    return servers.filter(
      (s) =>
        s.host.toLowerCase().includes(q) ||
        s.username.toLowerCase().includes(q) ||
        (s.alias || "").toLowerCase().includes(q)
    );
  }, [search, servers]);

  // 默认选中第一个
  if (!activeServer && filtered.length > 0) {
    setActiveServer(filtered[0]);
  }

  const handleOpen = (kind: TabKind) => {
    if (!activeServer) return;
    openTab(activeServer, kind);
    toast.info("已打开", activeServer.alias || activeServer.host);
    onClose();
  };

  const handleDoubleClick = (s: Server) => {
    const kind: TabKind = s.protocol === "sftp" ? "sftp" : "ssh";
    openTab(s, kind);
    onClose();
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div
        className="modal"
        onClick={(e) => e.stopPropagation()}
        style={{ width: 680, height: 480 }}
      >
        <div className="modal-header">
          <span>选择服务器</span>
          <button className="btn btn-ghost btn-icon" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
          {/* 左侧列表 */}
          <div
            style={{
              width: 280,
              borderRight: "1px solid var(--border-soft)",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <div style={{ padding: 8 }}>
              <input
                className="input"
                placeholder="搜索..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                autoFocus
              />
            </div>
            <div style={{ flex: 1, overflow: "auto" }}>
              {filtered.length === 0 ? (
                <div
                  style={{
                    padding: 20,
                    textAlign: "center",
                    color: "var(--fg-muted)",
                    fontSize: 12,
                  }}
                >
                  未找到服务器
                </div>
              ) : (
                filtered.map((s) => {
                  const isActive = activeServer?.id === s.id;
                  const group = groups.find((g) => g.id === s.groupId);
                  return (
                    <div
                      key={s.id}
                      onClick={() => setActiveServer(s)}
                      onDoubleClick={() => handleDoubleClick(s)}
                      style={{
                        padding: "8px 12px",
                        cursor: "pointer",
                        background: isActive
                          ? "var(--bg-active)"
                          : "transparent",
                        borderLeft: isActive
                          ? "2px solid var(--accent-blue)"
                          : "2px solid transparent",
                        display: "flex",
                        flexDirection: "column",
                        gap: 2,
                      }}
                    >
                      <div style={{ fontSize: 13, fontWeight: 500 }}>
                        {s.alias || `${s.username}@${s.host}`}
                      </div>
                      <div
                        style={{
                          fontSize: 11,
                          color: "var(--fg-muted)",
                          display: "flex",
                          gap: 6,
                        }}
                      >
                        <span
                          style={{
                            color: `var(--accent-${
                              s.protocol === "sftp"
                                ? "violet"
                                : s.protocol === "telnet"
                                ? "yellow"
                                : s.protocol === "rlogin"
                                ? "cyan"
                                : "blue"
                            })`,
                            textTransform: "uppercase",
                            fontWeight: 600,
                          }}
                        >
                          {s.protocol}
                        </span>
                        <span>
                          {s.username}@{s.host}:{s.port || "default"}
                        </span>
                        {group && (
                          <span style={{ color: "var(--fg-muted)" }}>
                            · {group.name}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
            <div
              style={{
                padding: 8,
                borderTop: "1px solid var(--border-soft)",
                fontSize: 11,
                color: "var(--fg-muted)",
              }}
            >
              双击直接打开
            </div>
          </div>

          {/* 右侧详情 */}
          <div style={{ flex: 1, padding: 20, display: "flex", flexDirection: "column" }}>
            {activeServer ? (
              <>
                <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>
                  {activeServer.alias || "未命名"}
                </div>
                <div style={{ fontSize: 12, color: "var(--fg-muted)", marginBottom: 16 }}>
                  {activeServer.username}@{activeServer.host}:
                  {activeServer.port || "默认"}
                </div>

                <div
                  style={{
                    flex: 1,
                    background: "var(--bg-input)",
                    borderRadius: 8,
                    padding: 14,
                    fontSize: 12,
                    color: "var(--fg-secondary)",
                    lineHeight: 1.7,
                    border: "1px solid var(--border-soft)",
                  }}
                >
                  <div>
                    <span style={{ color: "var(--fg-muted)" }}>协议：</span>
                    {activeServer.protocol.toUpperCase()}
                  </div>
                  <div>
                    <span style={{ color: "var(--fg-muted)" }}>主机：</span>
                    {activeServer.host}
                  </div>
                  <div>
                    <span style={{ color: "var(--fg-muted)" }}>端口：</span>
                    {activeServer.port || "默认"}
                  </div>
                  <div>
                    <span style={{ color: "var(--fg-muted)" }}>用户名：</span>
                    {activeServer.username}
                  </div>
                  <div>
                    <span style={{ color: "var(--fg-muted)" }}>认证：</span>
                    {activeServer.privateKey
                      ? "私钥"
                      : activeServer.password
                      ? "密码"
                      : "无"}
                  </div>
                  {activeServer.defaultRemotePath && (
                    <div>
                      <span style={{ color: "var(--fg-muted)" }}>远端默认路径：</span>
                      {activeServer.defaultRemotePath}
                    </div>
                  )}
                </div>

                <div
                  style={{
                    marginTop: 16,
                    display: "flex",
                    gap: 8,
                    justifyContent: "flex-end",
                  }}
                >
                  <button
                    className="btn"
                    onClick={() => handleOpen("ssh")}
                    disabled={activeServer.protocol === "sftp" && !activeServer.username}
                  >
                    <TerminalIcon /> Shell
                  </button>
                  <button
                    className="btn btn-primary"
                    onClick={() =>
                      handleOpen(activeServer.protocol === "sftp" ? "sftp" : "ssh")
                    }
                  >
                    {activeServer.protocol === "sftp" ? (
                      <>
                        <FolderIcon /> 打开 SFTP
                      </>
                    ) : (
                      <>
                        <TerminalIcon /> 打开 SSH
                      </>
                    )}
                  </button>
                </div>
              </>
            ) : (
              <div
                style={{
                  flex: 1,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "var(--fg-muted)",
                  fontSize: 13,
                  flexDirection: "column",
                  gap: 12,
                }}
              >
                <div>未选择服务器</div>
                <button
                  className="btn btn-primary"
                  onClick={() => {
                    openServerForm();
                    onClose();
                  }}
                >
                  <PlusIcon /> 新建服务器
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function CloseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
function TerminalIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path d="M2 3l3 3-3 3M6 9h4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function FolderIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path d="M1 3.5C1 3 1.4 2.5 2 2.5h2.5l1 1H10c.6 0 1 .4 1 1v4c0 .6-.4 1-1 1H2c-.6 0-1-.4-1-1V3.5z" stroke="currentColor" strokeWidth="1.2" fill="none" />
    </svg>
  );
}
function PlusIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path d="M6 1v10M1 6h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
