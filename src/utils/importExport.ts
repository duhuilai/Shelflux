// 导入导出（JSON 格式）
import type { Server, ServerGroup } from "../types";

export interface ExportPayload {
  version: 1;
  exportedAt: string;
  groups: ServerGroup[];
  servers: Server[];
  /** 导入端可以选择：merge | replace */
}

export function buildExportPayload(
  groups: ServerGroup[],
  servers: Server[]
): ExportPayload {
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    groups,
    servers: servers.map((s) => ({
      ...s,
      // 导出时清空敏感字段（密码、私钥）
      password: "",
      privateKey: "",
      passphrase: "",
    })),
  };
}

export function downloadJson(payload: ExportPayload, filename: string) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function parseImportPayload(text: string): ExportPayload {
  const data = JSON.parse(text);
  if (data.version !== 1) {
    throw new Error("不支持的导入文件版本");
  }
  if (!Array.isArray(data.groups) || !Array.isArray(data.servers)) {
    throw new Error("导入文件格式错误：缺少 groups/servers");
  }
  return data as ExportPayload;
}
