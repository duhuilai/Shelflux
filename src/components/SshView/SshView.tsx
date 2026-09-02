// SSH 终端视图 - 使用 xterm.js
import { useEffect, useRef, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import type { Tab } from "../../types";
import { useSettingsStore } from "../../stores/settingsStore";
import { toast } from "../../stores/toastStore";
import { buildXtermTheme } from "../../utils/xtermTheme";
import "./SshView.css";

interface Props {
  tab: Tab;
}

type Status = "connecting" | "connected" | "error" | "closed";

export function SshView({ tab }: Props) {
  const settings = useSettingsStore((s) => s.settings);
  const effectiveTheme = useSettingsStore((s) => s.effectiveTheme);

  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const [status, setStatus] = useState<Status>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchInput, setSearchInput] = useState("");
  const [searchInfo, setSearchInfo] = useState<{ current: number; total: number } | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const unlistenersRef = useRef<UnlistenFn[]>([]);
  // 重新连接入口（connect 定义在初始化 effect 内，用 ref 暴露给「重试」按钮）
  const reconnectRef = useRef<(() => void) | null>(null);

  // 初始化终端
  useEffect(() => {
    if (!containerRef.current) return;
    const term = new Terminal({
      fontSize: settings.terminal.fontSize,
      fontFamily: settings.terminal.fontFamily,
      cursorBlink: settings.terminal.cursorBlink,
      theme: buildXtermTheme(
        useSettingsStore.getState().effectiveTheme,
        settings.terminal
      ),
      allowProposedApi: true,
      cursorStyle: "bar",
      scrollback: 10000,
      convertEol: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const search = new SearchAddon();
    term.loadAddon(search);
    const links = new WebLinksAddon();
    term.loadAddon(links);
    term.open(containerRef.current);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;
    searchRef.current = search;

    term.writeln("\x1b[90m正在连接服务器...\x1b[0m");

    // 终端输入 -> 后端
    term.onData((data) => {
      const sid = sessionIdRef.current;
      if (sid) {
        invoke("ssh_shell_write", { sessionId: sid, data }).catch(() => {});
      }
    });

    // 监听窗口尺寸变化
    const resizeObserver = new ResizeObserver(() => {
      try {
        fit.fit();
        const sid = sessionIdRef.current;
        if (sid) {
          invoke("ssh_shell_resize", {
            sessionId: sid,
            cols: term.cols,
            rows: term.rows,
          }).catch(() => {});
        }
      } catch {
        /* noop */
      }
    });
    resizeObserver.observe(containerRef.current);

    // 监听后端输出
    const listenOutputs = async () => {
      // 通用输出监听
      const unlistenOut = await listen<{
        session_id: string;
        kind: string;
        data: string;
      }>("ssh-output", (event) => {
        const p = event.payload;
        if (p.session_id !== sessionIdRef.current) return;
        if (p.kind === "error") {
          term.writeln(`\r\n\x1b[31m${p.data}\x1b[0m`);
        } else {
          term.write(p.data);
        }
      });
      const unlistenClosed = await listen<{ session_id: string }>(
        "ssh-closed",
        (event) => {
          if (event.payload.session_id === sessionIdRef.current) {
            setStatus("closed");
            term.writeln("\r\n\x1b[90m[连接已关闭]\x1b[0m");
          }
        }
      );
      unlistenersRef.current.push(unlistenOut, unlistenClosed);
    };
    listenOutputs();

    // 建立连接
    const connect = async () => {
      try {
        setStatus("connecting");
        const sid = await invoke<string>("ssh_shell_connect", {
          server: tab.server,
          cols: term.cols,
          rows: term.rows,
        });
        sessionIdRef.current = sid;
        setStatus("connected");
        term.focus();
      } catch (e: any) {
        setStatus("error");
        setError(e.toString());
        term.writeln(`\r\n\x1b[31m连接失败: ${e}\x1b[0m`);
      }
    };
    reconnectRef.current = connect;
    connect();

    return () => {
      reconnectRef.current = null;
      resizeObserver.disconnect();
      const sid = sessionIdRef.current;
      if (sid) {
        invoke("ssh_shell_close", { sessionId: sid }).catch(() => {});
      }
      unlistenersRef.current.forEach((u) => u());
      unlistenersRef.current = [];
      term.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id]);

  // 监听设置变化，实时更新
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = settings.terminal.fontSize;
    term.options.fontFamily = settings.terminal.fontFamily;
    term.options.cursorBlink = settings.terminal.cursorBlink;
    term.options.theme = buildXtermTheme(effectiveTheme, settings.terminal);
    try {
      fitRef.current?.fit();
    } catch {
      /* noop */
    }
  }, [settings.terminal, effectiveTheme]);

  // 搜索快捷键 Ctrl/Cmd+F
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "f" && !searchOpen) {
        e.preventDefault();
        setSearchOpen((v) => !v);
        setSearchInput("");
        setSearchInfo(null);
      }
      if (e.key === "Escape" && searchOpen) {
        setSearchOpen(false);
        searchRef.current?.clearDecorations();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [searchOpen]);

  // 复制 / 粘贴 - 使用 xterm.js attachCustomKeyEventHandler
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      const isCtrl = e.ctrlKey || e.metaKey;

      // Ctrl+V 粘贴：交给 xterm.js 原生的 paste 事件处理。
      // paste 事件 → onData → ssh_shell_write → 远端回显，只显示一份。
      // 这里仅返回 false，阻止 xterm 把原始的 Ctrl+V(0x16) 控制字符发到终端。
      // 注意：不能 preventDefault，否则浏览器不会触发 paste 事件。
      if (isCtrl && e.key === "v") {
        return false;
      }

      // Ctrl+C 复制（仅当有选中文本时）
      if (isCtrl && e.key === "c" && term.hasSelection()) {
        e.preventDefault();
        const sel = term.getSelection();
        invoke("copy_to_clipboard", { text: sel }).then(() => {
          toast.success("已复制", sel.length > 40 ? sel.slice(0, 40) + "..." : sel);
        });
        return false; // 阻止发送 ^C 到终端
      }

      return true; // 其他按键交给 xterm.js 默认处理
    });
  }, []);

  // 执行搜索
  const runSearch = useCallback(
    (direction: "next" | "prev" = "next") => {
      if (!searchRef.current || !searchInput) {
        setSearchInfo(null);
        return;
      }
      const found = searchRef.current.findNext(searchInput, {
        caseSensitive: false,
        wholeWord: false,
        regex: false,
        incremental: false,
      });
      setSearchInfo(found ? { current: 1, total: 1 } : null);
    },
    [searchInput]
  );

  useEffect(() => {
    if (!searchOpen) return;
    const handler = setTimeout(() => runSearch("next"), 200);
    return () => clearTimeout(handler);
  }, [searchInput, searchOpen, runSearch]);

  return (
    <div className="ssh-view">
      <div className="ssh-toolbar">
        <div className="status">
          <span className={`status-dot ${status === "connected" ? "connected" : status === "error" ? "error" : ""}`} />
          <span>
            {status === "connecting" && "连接中..."}
            {status === "connected" && "已连接"}
            {status === "error" && "连接失败"}
            {status === "closed" && "已断开"}
          </span>
          <span style={{ color: "var(--fg-muted)" }}>·</span>
          <span style={{ color: "var(--fg-muted)" }}>
            {tab.server.username}@{tab.server.host}
          </span>
        </div>
        <div style={{ flex: 1 }} />
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => {
            setSearchOpen((v) => !v);
            setSearchInfo(null);
          }}
          title="搜索 (Ctrl+F)"
        >
          <SearchIcon /> 搜索
        </button>
      </div>

      <div className="ssh-terminal-container" ref={containerRef}>
        {status === "error" && error && (
          <div className="ssh-terminal-overlay">
            <div style={{ color: "var(--color-error)", fontSize: 14, fontWeight: 600 }}>
              连接失败
            </div>
            <div style={{ maxWidth: 480, textAlign: "center", fontFamily: "var(--font-mono)" }}>
              {error}
            </div>
            <button
              className="btn btn-primary btn-sm"
              onClick={() => {
                // 重新发起 SSH 连接（不再重载整个应用，避免丢失其它标签页与传输任务）
                termRef.current?.clear();
                setError(null);
                reconnectRef.current?.();
              }}
            >
              重试
            </button>
          </div>
        )}
      </div>

      {searchOpen && (
        <div className="ssh-search-bar">
          <SearchIcon />
          <input
            placeholder="搜索..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") runSearch("next");
              if (e.key === "Escape") setSearchOpen(false);
            }}
            autoFocus
          />
          <span className={`ssh-search-info ${searchInfo ? "" : "hidden"}`}>
            {searchInfo ? "1 / 1" : "无结果"}
          </span>
          <button
            className="btn btn-ghost btn-icon btn-sm"
            onClick={() => setSearchOpen(false)}
            title="关闭 (Esc)"
          >
            <CloseIcon />
          </button>
        </div>
      )}
    </div>
  );
}

function SearchIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <circle cx="5" cy="5" r="3.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M7.5 7.5L11 11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
function CloseIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
      <path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
