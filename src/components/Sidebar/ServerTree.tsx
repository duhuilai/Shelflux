// 递归渲染分组与服务器（支持拖动排序）
import { useState, useRef, useCallback, useEffect } from "react";
import type { Server, ServerGroup } from "../../types";
import { useServerStore } from "../../stores/serverStore";
import { useTabStore } from "../../stores/tabStore";
import { useUiStore } from "../../stores/uiStore";
import { toast } from "../../stores/toastStore";

interface Props {
  groups: ServerGroup[];
  servers: Server[];
}

type DropTarget =
  | { kind: "group"; id: string | null }
  | { kind: "before"; serverId: string }
  | { kind: "after"; serverId: string };

// 右键菜单项
interface ContextMenuItem {
  label: string;
  icon: React.ReactNode;
  action: () => void;
  danger?: boolean;
}

// 全局右键菜单状态
let contextMenuState: {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
} | null = null;

function showContextMenu(x: number, y: number, items: ContextMenuItem[]) {
  contextMenuState = { x, y, items, onClose: () => {} };
  document.dispatchEvent(new CustomEvent("shelflux-context-menu", { detail: contextMenuState }));
}

function hideContextMenu() {
  if (contextMenuState?.onClose) {
    contextMenuState.onClose();
  }
  contextMenuState = null;
}

export function ServerTree({ groups, servers }: Props) {
  const topLevelServers = servers.filter((s) => !s.groupId);

  return (
    <div>
      {groups.map((g) => (
        <GroupNode
          key={g.id}
          group={g}
          servers={servers.filter((s) => s.groupId === g.id)}
        />
      ))}
      {topLevelServers.map((s) => (
        <ServerNode key={s.id} server={s} groupId={null} indent={0} />
      ))}
    </div>
  );
}

function GroupNode({ group, servers }: { group: ServerGroup; servers: Server[] }) {
  const toggleCollapsed = useServerStore((s) => s.toggleGroupCollapsed);
  const renameGroup = useServerStore((s) => s.renameGroup);
  const removeGroup = useServerStore((s) => s.removeGroup);
  const openServerForm = useUiStore((s) => s.openServerForm);
  const askConfirm = useUiStore((s) => s.askConfirm);
  const moveServer = useServerStore((s) => s.moveServer);
  const [editing, setEditing] = useState(false);
  const [tempName, setTempName] = useState(group.name);
  const [dropOver, setDropOver] = useState(false);
  const dragCounter = useRef(0);

  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const ok = await askConfirm({
      title: "删除分组",
      message: `确定要删除分组"${group.name}"吗？分组内的服务器会移到顶层。`,
      danger: true,
      confirmText: "删除",
    });
    if (ok) {
      removeGroup(group.id);
      toast.success("已删除分组", group.name);
    }
  };

  const handleAddServer = (e: React.MouseEvent) => {
    e.stopPropagation();
    openServerForm(undefined, group.id);
  };

  const handleRename = () => {
    setEditing(true);
    setTempName(group.name);
  };

  const submitRename = () => {
    if (tempName.trim() && tempName !== group.name) {
      renameGroup(group.id, tempName.trim());
    }
    setEditing(false);
  };

  // 拖动接收（drop 到分组空白处 -> 移动到该分组）
  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  };
  const onDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current += 1;
    setDropOver(true);
  };
  const onDragLeave = (e: React.DragEvent) => {
    dragCounter.current -= 1;
    if (dragCounter.current <= 0) {
      dragCounter.current = 0;
      setDropOver(false);
    }
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current = 0;
    setDropOver(false);
    const data = e.dataTransfer.getData("application/x-shelflux-server");
    if (!data) return;
    const { id } = JSON.parse(data);
    if (id) {
      moveServer(id, group.id);
    }
  };

  return (
    <div
      className="tree-item"
      onDragOver={onDragOver}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div
        className={`tree-row group-row ${dropOver ? "dragover" : ""}`}
        onClick={() => {
          if (!editing) toggleCollapsed(group.id);
        }}
      >
        <span className={`tree-chevron ${group.collapsed ? "collapsed" : ""}`}>
          <ChevronIcon />
        </span>
        <span className="tree-icon">
          <FolderIcon />
        </span>
        {editing ? (
          <input
            autoFocus
            value={tempName}
            onChange={(e) => setTempName(e.target.value)}
            onBlur={submitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitRename();
              if (e.key === "Escape") setEditing(false);
            }}
            onClick={(e) => e.stopPropagation()}
            style={{
              flex: 1,
              background: "var(--bg-input)",
              border: "1px solid var(--border-default)",
              borderRadius: 4,
              padding: "1px 6px",
              color: "var(--fg-primary)",
              outline: 0,
              minWidth: 0,
            }}
          />
        ) : (
          <span className="tree-label">{group.name}</span>
        )}
        <span className="tree-label-secondary">{servers.length}</span>
        <div className="tree-actions">
          <button
            className="tree-action-btn"
            onClick={handleAddServer}
            title="在此分组添加服务器"
          >
            <PlusIcon />
          </button>
          <button className="tree-action-btn" onClick={handleRename} title="重命名">
            <EditIcon />
          </button>
          <button className="tree-action-btn danger" onClick={handleDelete} title="删除分组">
            <TrashIcon />
          </button>
        </div>
      </div>
      {!group.collapsed && (
        <div className="tree-children">
          {servers.map((s) => (
            <ServerNode
              key={s.id}
              server={s}
              groupId={group.id}
              indent={1}
            />
          ))}
          {servers.length === 0 && (
            <div
              style={{
                paddingLeft: 32,
                padding: "4px 8px 4px 32px",
                fontSize: 11,
                color: "var(--fg-muted)",
                fontStyle: "italic",
              }}
            >
              拖动或添加服务器
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ServerNode({
  server,
  groupId,
  indent,
}: {
  server: Server;
  groupId: string | null;
  indent: number;
}) {
  const activeTabId = useTabStore((s) => s.activeTabId);
  const tabs = useTabStore((s) => s.tabs);
  const openTab = useTabStore((s) => s.openTab);
  const setActive = useTabStore((s) => s.setActive);
  const updateServer = useServerStore((s) => s.updateServer);
  const removeServer = useServerStore((s) => s.removeServer);
  const moveServer = useServerStore((s) => s.moveServer);
  const openServerForm = useUiStore((s) => s.openServerForm);
  const askConfirm = useUiStore((s) => s.askConfirm);
  const [editing, setEditing] = useState(false);
  const [tempAlias, setTempAlias] = useState(server.alias || "");
  const [dragOver, setDragOver] = useState<"top" | "bottom" | null>(null);

  const isOpen = tabs.some(
    (t) => t.server.id === server.id && t.kind === (server.protocol === "sftp" ? "sftp" : "ssh")
  );

  const handleClick = (e: React.MouseEvent) => {
    // 双击连接
    if (e.detail === 2) {
      openTab(server);
      return;
    }
    // 单击不做连接操作，只显示右键菜单提示
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const items: ContextMenuItem[] = [
      {
        label: "编辑",
        icon: <EditIcon />,
        action: () => openServerForm(server),
      },
      {
        label: "设置别名",
        icon: <TagIcon />,
        action: () => {
          setEditing(true);
          setTempAlias(server.alias || "");
        },
      },
      {
        label: "删除",
        icon: <TrashIcon />,
        danger: true,
        action: async () => {
          const ok = await askConfirm({
            title: "删除服务器",
            message: `确定要删除服务器"${
              server.alias || `${server.username}@${server.host}`
            }"吗？此操作不可撤销。`,
            danger: true,
            confirmText: "删除",
          });
          if (ok) {
            removeServer(server.id);
            toast.success("已删除", server.alias || server.host);
          }
        },
      },
    ];

    showContextMenu(e.clientX, e.clientY, items);
  };

  const submitRename = () => {
    updateServer(server.id, { alias: tempAlias.trim() });
    setEditing(false);
  };

  // 拖动
  const onDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData(
      "application/x-shelflux-server",
      JSON.stringify({ id: server.id })
    );
    e.dataTransfer.effectAllowed = "move";
    (e.currentTarget as HTMLElement).classList.add("dragging");
  };
  const onDragEnd = (e: React.DragEvent) => {
    (e.currentTarget as HTMLElement).classList.remove("dragging");
  };

  // 接收拖动（重新排序 / 跨组）
  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const offsetY = e.clientY - rect.top;
    setDragOver(offsetY < rect.height / 2 ? "top" : "bottom");
  };
  const onDragLeave = () => setDragOver(null);
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const data = e.dataTransfer.getData("application/x-shelflux-server");
    setDragOver(null);
    if (!data) return;
    const { id: draggedId } = JSON.parse(data);
    if (!draggedId || draggedId === server.id) return;
    // 计算同组中目标位置
    const sameGroup = useServerStore.getState().servers.filter((s) => s.groupId === server.groupId);
    const targetIndex = sameGroup.findIndex((s) => s.id === server.id);
    const beforeIndex = dragOver === "top" ? targetIndex : targetIndex + 1;
    moveServer(draggedId, server.groupId ?? null, beforeIndex);
  };

  const title = server.alias || `${server.username}@${server.host}`;
  const sub = server.alias ? `${server.username}@${server.host}` : server.host;

  return (
    <div
      className="tree-item"
      style={{ position: "relative" }}
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {dragOver === "top" && <div className="tree-drop-placeholder" />}
      <div
        className={`tree-row server-row ${isOpen ? "active" : ""}`}
        style={{ paddingLeft: 8 + indent * 16 }}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        title={`双击连接 ${server.host}:${server.port || "default"}`}
      >
        <span className="tree-chevron" style={{ visibility: "hidden" }} />
        <span className={`tree-icon server-${server.protocol}`}>
          <ServerProtocolIcon kind={server.protocol} />
        </span>
        {editing ? (
          <input
            autoFocus
            value={tempAlias}
            onChange={(e) => setTempAlias(e.target.value)}
            onBlur={submitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitRename();
              if (e.key === "Escape") setEditing(false);
            }}
            onClick={(e) => e.stopPropagation()}
            style={{
              flex: 1,
              background: "var(--bg-input)",
              border: "1px solid var(--border-default)",
              borderRadius: 4,
              padding: "1px 6px",
              color: "var(--fg-primary)",
              outline: 0,
              minWidth: 0,
              fontSize: 12,
            }}
          />
        ) : (
          <>
            <span className="tree-label">{title}</span>
            <span className="tree-label-secondary">
              {server.username}@{sub}
            </span>
          </>
        )}
      </div>
      {dragOver === "bottom" && <div className="tree-drop-placeholder" />}
    </div>
  );
}

function ChevronIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
      <path d="M3 2l4 3-4 3" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function FolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path
        d="M1.5 3.5C1.5 3 1.9 2.5 2.5 2.5h2.7c.4 0 .8.2 1 .5L7 4h4.5c.6 0 1 .4 1 1v5.5c0 .6-.4 1-1 1H2.5c-.6 0-1-.4-1-1V3.5z"
        stroke="currentColor"
        strokeWidth="1.2"
        fill="none"
      />
    </svg>
  );
}
function ServerProtocolIcon({ kind }: { kind: string }) {
  if (kind === "sftp") {
    return (
      <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
        <path d="M2 8h9M2 5h9M2 11h9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        <circle cx="2.5" cy="5" r="0.8" fill="currentColor" />
        <circle cx="2.5" cy="8" r="0.8" fill="currentColor" />
        <circle cx="2.5" cy="11" r="0.8" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
      <path d="M2 3l4 3.5L2 10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M7 3h4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
function EditIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
      <path d="M1 8l4-4 3 3-4 4H1V8zM5 4l2-2 2 2-2 2-2-2z" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}
function TrashIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
      <path d="M2 3h7M4 3V1.5h3V3M3 3l.5 6.5h4L8 3" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function PlusIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
      <path d="M5 1v8M1 5h8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
function TagIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
      <path d="M1 1h4l5 5-4 4-5-5V1z" stroke="currentColor" strokeWidth="1" fill="none" />
      <circle cx="3" cy="3" r="0.6" fill="currentColor" />
    </svg>
  );
}
