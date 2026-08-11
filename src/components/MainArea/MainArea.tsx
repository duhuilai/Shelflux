// 主区域：根据当前激活的页签渲染对应视图
import { useTabStore } from "../../stores/tabStore";
import { EmptyState } from "./EmptyState";
import { SftpView } from "../SftpView/SftpView";
import { SshView } from "../SshView/SshView";

export function MainArea() {
  const activeTabId = useTabStore((s) => s.activeTabId);
  const tabs = useTabStore((s) => s.tabs);

  if (tabs.length === 0) return <EmptyState />;

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        // min-width:0 必须显式设置：flex 子项默认 min-width:auto，
        // 会被内容（长文件名等）撑宽，导致分栏不跟随窗口且底部出现横向滚动条
        minWidth: 0,
        display: "flex",
        overflow: "hidden",
      }}
    >
      {tabs.map((t) => (
        // 关键：始终挂载所有页签，仅隐藏非激活者（display:none）。
        // 这样切换 tab 时不会卸载 SshView/SftpView 组件，SSH 连接不被
        // ssh_shell_close 切断、SFTP 的当前目录/文件列表等状态得以保留。
        // 重新显示时 SshView 的 ResizeObserver 会自动 fit 终端尺寸。
        <div
          key={t.id}
          style={{
            flex: 1,
            minHeight: 0,
            minWidth: 0,
            display: t.id === activeTabId ? "flex" : "none",
            // 隐藏态仍保持布局基准，避免 xterm 拿到 0 尺寸后渲染异常
            flexDirection: "column",
          }}
        >
          {t.kind === "sftp" && <SftpView tab={t} />}
          {(t.kind === "ssh" || t.kind === "telnet" || t.kind === "rlogin") && (
            <SshView tab={t} />
          )}
        </div>
      ))}
    </div>
  );
}
