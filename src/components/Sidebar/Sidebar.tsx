// 侧边栏 - 服务器列表
import { useMemo, useState } from "react";
import { useServerStore } from "../../stores/serverStore";
import { useUiStore } from "../../stores/uiStore";
import { useForwardStore } from "../../stores/forwardStore";
import { toast } from "../../stores/toastStore";
import { ServerTree } from "./ServerTree";
import { buildExportPayload, downloadJson } from "../../utils/importExport";
import "./Sidebar.css";

export function Sidebar() {
  const [search, setSearch] = useState("");
  const groups = useServerStore((s) => s.groups);
  const servers = useServerStore((s) => s.servers);
  const importData = useServerStore((s) => s.importData);
  const addGroup = useServerStore((s) => s.addGroup);
  const openServerForm = useUiStore((s) => s.openServerForm);
  const openSettings = useUiStore((s) => s.openSettings);
  const openForwardPanel = useUiStore((s) => s.openForwardPanel);
  const askConfirm = useUiStore((s) => s.askConfirm);
  const forwardRuntime = useForwardStore((s) => s.runtime);
  const activeForwards = useMemo(
    () => Object.values(forwardRuntime).filter((r) => r.active).length,
    [forwardRuntime]
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return { groups, servers };
    return {
      groups: groups.filter((g) => g.name.toLowerCase().includes(q)),
      servers: servers.filter(
        (s) =>
          s.host.toLowerCase().includes(q) ||
          s.username.toLowerCase().includes(q) ||
          (s.alias || "").toLowerCase().includes(q)
      ),
    };
  }, [search, groups, servers]);

  const handleExport = () => {
    const data = buildExportPayload(groups, servers);
    const filename = `shelflux-export-${new Date().toISOString().slice(0, 10)}.json`;
    downloadJson(data, filename);
    toast.success("已导出", filename);
  };

  const handleAddGroup = () => {
    const name = prompt("分组名称：", "新分组");
    if (name) addGroup(name);
  };

  const handleImport = async () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        if (data.version !== 1) throw new Error("不支持的版本");
        const ok = await askConfirm({
          title: "确认导入",
          message: `将合并 ${data.groups?.length || 0} 个分组、${data.servers?.length || 0} 个服务器到当前列表。`,
          confirmText: "导入",
        });
        if (!ok) return;
        importData(data.groups || [], data.servers || []);
        toast.success("导入成功");
      } catch (e: any) {
        toast.error("导入失败", e.message || "未知错误");
      }
    };
    input.click();
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div className="search-box">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          <input type="text" placeholder="搜索服务器..." value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <button className="add-group-btn" onClick={handleAddGroup}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 5v14M5 12h14" />
          </svg>
          新建分组
        </button>
      </div>

      <div className="sidebar-content">
        {groups.length === 0 && servers.length === 0 ? (
          <div className="sidebar-empty">
            <div>暂无服务器</div>
            <div style={{ fontSize: 12, color: "var(--fg-muted)", marginTop: 4 }}>
              添加你的第一台服务器
            </div>
            <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={() => openServerForm()}>
              新建服务器
            </button>
          </div>
        ) : (
          <ServerTree groups={filtered.groups} servers={filtered.servers} />
        )}
      </div>

      <div className="sidebar-footer">
        <button className="footer-btn" onClick={handleImport}>导入</button>
        <button className="footer-btn" onClick={handleExport}>导出</button>
        <button className="footer-btn settings-btn" onClick={openSettings} title="设置">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="3" />
            <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
          </svg>
        </button>
      </div>
    </aside>
  );
}
