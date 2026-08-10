// 空状态
import { useUiStore } from "../../stores/uiStore";
import { useServerStore } from "../../stores/serverStore";
import { toast } from "../../stores/toastStore";
import { parseImportPayload } from "../../utils/importExport";
import logoUrl from "/logo.png";

export function EmptyState() {
  const openServerForm = useUiStore((s) => s.openServerForm);
  const importData = useServerStore((s) => s.importData);

  const handleImport = async () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const data = parseImportPayload(text);
        importData(data.groups, data.servers);
        toast.success("导入成功", `分组 ${data.groups.length} 个，服务器 ${data.servers.length} 个`);
      } catch (e: any) {
        toast.error("导入失败", e.message || "未知错误");
      }
    };
    input.click();
  };

  return (
    <div className="empty-state">
      <img className="empty-state-logo" src={logoUrl} alt="Shelflux" />
      <div className="empty-state-title">Shelflux</div>
      <div className="empty-state-desc">从左侧列表选择一个服务器开始</div>
      <div className="empty-state-actions">
        <button className="btn btn-primary" onClick={() => openServerForm()}>新建服务器</button>
        <button className="btn" onClick={handleImport}>导入</button>
      </div>
    </div>
  );
}
