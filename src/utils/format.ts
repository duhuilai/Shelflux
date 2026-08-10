// 文件大小等格式化
export function formatSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatSpeed(bytesPerSec: number): string {
  return `${formatSize(bytesPerSec)}/s`;
}

export function formatDate(timestamp?: number): string {
  if (!timestamp) return "";
  const d = new Date(timestamp * 1000);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hh}:${mm}`;
}

export function joinPath(...parts: string[]): string {
  return parts
    .filter(Boolean)
    .map((p, i) => {
      if (i === 0) return p.replace(/[\/\\]+$/, "");
      return p.replace(/^[\/\\]+|[\/\\]+$/g, "");
    })
    .join("/");
}

export function basename(path: string): string {
  return path.split(/[\/\\]/).filter(Boolean).pop() || path;
}

export function dirname(path: string): string {
  const parts = path.split(/[\/\\]/).filter(Boolean);
  if (parts.length <= 1) return path;
  parts.pop();
  const prefix = path.startsWith("/") ? "/" : "";
  return prefix + parts.join("/");
}

export function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

export function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
