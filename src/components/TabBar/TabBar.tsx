// 多页签栏
import { useTabStore } from "../../stores/tabStore";
import { useUiStore } from "../../stores/uiStore";
import "./TabBar.css";

export function TabBar() {
  const tabs = useTabStore((s) => s.tabs);
  const activeTabId = useTabStore((s) => s.activeTabId);
  const setActive = useTabStore((s) => s.setActive);
  const closeTab = useTabStore((s) => s.closeTab);
  const openServerPicker = useUiStore((s) => s.openServerPicker);

  return (
    <div className="tabbar">
      {tabs.map((t) => {
        const active = t.id === activeTabId;
        return (
          <div
            key={t.id}
            className={`tab ${active ? "active" : ""}`}
            onClick={() => setActive(t.id)}
            title={t.title}
          >
            <span className="tab-icon">
              <TabKindIcon kind={t.kind} />
            </span>
            <span className="tab-title">{t.title}</span>
            <span className="tab-status connecting" title="已连接" />
            <span
              className="tab-close"
              onClick={(e) => {
                e.stopPropagation();
                closeTab(t.id);
              }}
              title="关闭"
            >
              <CloseIcon />
            </span>
          </div>
        );
      })}
      <div
        className="tab-new"
        onClick={openServerPicker}
        title="新建连接 (Ctrl/Cmd + N)"
      >
        <PlusIcon />
      </div>
    </div>
  );
}

function TabKindIcon({ kind }: { kind: string }) {
  if (kind === "sftp") {
    return (
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
        <path d="M1 7h10M1 4h10M1 10h10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path d="M2 2l4 4-4 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M7 2h3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
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
function CloseIcon() {
  return (
    <svg width="9" height="9" viewBox="0 0 9 9" fill="none">
      <path d="M1.5 1.5l6 6M7.5 1.5l-6 6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
