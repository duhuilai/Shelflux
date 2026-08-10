// 路径面包屑 - 支持点击切换、编辑
import { useState, useEffect, useRef } from "react";

interface Props {
  path: string;
  editable?: boolean;
  onPathChange: (p: string) => void;
  onEditingChange?: (editing: boolean) => void;
}

export function PathBreadcrumb({ path, editable, onPathChange, onEditingChange }: Props) {
  const [editing, setEditing] = useState(false);
  const [temp, setTemp] = useState(path);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    onEditingChange?.(editing);
  }, [editing, onEditingChange]);

  useEffect(() => {
    if (editing) {
      setTemp(path);
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing, path]);

  // 解析路径为段（处理 Windows 和 Unix 路径）
  const segments = parsePathSegments(path);

  const handleSegmentClick = (fullPath: string) => {
    onPathChange(fullPath);
  };

  const submit = () => {
    if (temp && temp !== path) onPathChange(temp);
    setEditing(false);
  };

  if (editing) {
    return (
      <div className="sftp-breadcrumb">
        <input
          ref={inputRef}
          className="sftp-breadcrumb-input"
          value={temp}
          onChange={(e) => setTemp(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
            if (e.key === "Escape") setEditing(false);
          }}
          onBlur={submit}
        />
      </div>
    );
  }

  return (
    <div
      className="sftp-breadcrumb"
      onDoubleClick={() => editable && setEditing(true)}
      title={editable ? "双击编辑路径" : ""}
    >
      {segments.map((seg, i) => {
        const isLast = i === segments.length - 1;
        return (
          <span key={i} style={{ display: "inline-flex", alignItems: "center" }}>
            <span
              className="sftp-breadcrumb-segment"
              onClick={() => handleSegmentClick(seg.full)}
              title={seg.full}
            >
              {seg.label}
            </span>
            {!isLast && <span className="sftp-breadcrumb-separator">/</span>}
          </span>
        );
      })}
    </div>
  );
}

interface PathSegment {
  label: string;
  full: string;
}

function parsePathSegments(path: string): PathSegment[] {
  if (!path) return [];
  const isWindows = /^[A-Z]:/i.test(path) || path.startsWith("\\\\");
  const parts = path.split(/[\/\\]/).filter(Boolean);
  if (isWindows && path.startsWith("\\\\")) {
    // UNC 路径
    return parts.map((p, i) => {
      const full = "\\\\" + parts.slice(0, i + 1).join("\\");
      return { label: p, full };
    });
  }
  if (isWindows) {
    // C:\a\b\c
    return parts.map((p, i) => {
      const full = parts.slice(0, i + 1).join("\\");
      // 第一段是盘符
      const withSep = i === 0 ? full + "\\" : full;
      return { label: p, full: withSep };
    });
  }
  // Unix: /a/b/c
  return [
    { label: "/", full: "/" },
    ...parts.map((p, i) => {
      const full = "/" + parts.slice(0, i + 1).join("/");
      return { label: p, full };
    }),
  ];
}
