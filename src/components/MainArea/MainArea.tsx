// 主区域：根据当前激活的页签渲染对应视图
import { useTabStore } from "../../stores/tabStore";
import { EmptyState } from "./EmptyState";
import { SftpView } from "../SftpView/SftpView";
import { SshView } from "../SshView/SshView";

export function MainArea() {
  const activeTabId = useTabStore((s) => s.activeTabId);
  const tab = useTabStore((s) =>
    s.tabs.find((t) => t.id === activeTabId)
  );

  if (!tab) return <EmptyState />;

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
      {tab.kind === "sftp" && <SftpView tab={tab} />}
      {(tab.kind === "ssh" || tab.kind === "telnet" || tab.kind === "rlogin") && (
        <SshView tab={tab} />
      )}
    </div>
  );
}
