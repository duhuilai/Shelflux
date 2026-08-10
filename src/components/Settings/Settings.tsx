// 设置对话框 - 终端样式、默认应用、关于
import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore } from "../../stores/settingsStore";
import { useUiStore } from "../../stores/uiStore";
import { toast } from "../../stores/toastStore";
import type { AppSettings, KnownHostEntry } from "../../types";
import "./Settings.css";

/** 秒级时间戳 → 本地时间字符串 */
function formatHostTime(ts: number): string {
  if (!ts) return "—";
  const d = new Date(ts * 1000);
  if (Number.isNaN(d.getTime())) return "—";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(
    d.getHours()
  )}:${p(d.getMinutes())}`;
}

interface Props {
  onClose: () => void;
}

const COLORS = [
  { name: "默认蓝", value: "#7aa2f7" },
  { name: "紫色", value: "#bb9af7" },
  { name: "青色", value: "#7dcfff" },
  { name: "粉色", value: "#f7768e" },
  { name: "绿色", value: "#9ece6a" },
  { name: "黄色", value: "#e0af68" },
  { name: "白色", value: "#e6e8ef" },
  { name: "深灰", value: "#9aa1b5" },
];

const FG_COLORS = [
  { name: "白", value: "#e6e8ef" },
  { name: "灰", value: "#9aa1b5" },
  { name: "黄", value: "#e0af68" },
  { name: "绿", value: "#9ece6a" },
];

const FONT_SIZES = [11, 12, 13, 14, 15, 16, 18, 20];

const THEME_OPTIONS: { value: AppSettings["theme"]; label: string }[] = [
  { value: "dark", label: "暗色" },
  { value: "light", label: "亮色" },
  { value: "system", label: "跟随系统" },
];

export function Settings({ onClose }: Props) {
  const [tab, setTab] = useState<
    "appearance" | "terminal" | "files" | "security" | "about"
  >("appearance");
  const settings = useSettingsStore((s) => s.settings);
  const effectiveTheme = useSettingsStore((s) => s.effectiveTheme);
  const setSettings = useSettingsStore((s) => s.setSettings);
  const reset = useSettingsStore((s) => s.reset);
  const askConfirm = useUiStore((s) => s.askConfirm);
  const [appInfo, setAppInfo] = useState<{ version: string; dataDir: string; homeDir: string } | null>(null);
  const [hosts, setHosts] = useState<KnownHostEntry[]>([]);
  const [hostsLoading, setHostsLoading] = useState(false);

  // 更新检查状态机：idle | checking | uptodate | available | downloading | downloaded | error
  const [updateState, setUpdateState] = useState<
    "idle" | "checking" | "uptodate" | "available" | "downloading" | "downloaded" | "error"
  >("idle");
  const [updateInfo, setUpdateInfo] = useState<{
    latest_version: string;
    release_notes: string;
    size?: number;
    download_url?: string;
  } | null>(null);
  const [localPath, setLocalPath] = useState<string | null>(null);
  const [updateError, setUpdateError] = useState("");

  const loadHosts = async () => {
    setHostsLoading(true);
    try {
      const list = await invoke<KnownHostEntry[]>("known_hosts_list");
      list.sort((a, b) => a.host.localeCompare(b.host) || a.port - b.port);
      setHosts(list);
    } catch (e: any) {
      toast.error("读取主机密钥失败", e.toString());
    } finally {
      setHostsLoading(false);
    }
  };

  // 切到"安全"页时才拉取列表
  useEffect(() => {
    if (tab === "security") void loadHosts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const removeHost = async (host: string, port: number) => {
    const ok = await askConfirm({
      title: "删除主机密钥",
      message: `删除 ${host}:${port} 的指纹记录后，下次连接会重新按首次连接处理并自动信任新密钥。确定吗？`,
      confirmText: "删除",
      danger: true,
    });
    if (!ok) return;
    try {
      await invoke("known_hosts_remove", { host, port });
      await loadHosts();
      toast.success("已删除", `${host}:${port}`);
    } catch (e: any) {
      toast.error("删除失败", e.toString());
    }
  };

  const clearHosts = async () => {
    const ok = await askConfirm({
      title: "清空主机密钥",
      message: `将删除全部 ${hosts.length} 条已信任的主机指纹，此操作不可撤销。确定吗？`,
      confirmText: "清空",
      danger: true,
    });
    if (!ok) return;
    try {
      await invoke("known_hosts_clear");
      await loadHosts();
      toast.success("已清空");
    } catch (e: any) {
      toast.error("清空失败", e.toString());
    }
  };

  const copyFingerprint = async (fp: string) => {
    try {
      await navigator.clipboard.writeText(fp);
      toast.success("已复制指纹");
    } catch {
      toast.error("复制失败");
    }
  };

  const checkUpdate = async () => {
    setUpdateState("checking");
    setUpdateError("");
    try {
      const info = await invoke<{
        latest_version: string;
        has_update: boolean;
        release_notes: string;
        size?: number;
        download_url?: string;
      }>("check_update");
      if (info.has_update && info.download_url) {
        setUpdateInfo({
          latest_version: info.latest_version,
          release_notes: info.release_notes || "",
          size: info.size,
          download_url: info.download_url,
        });
        setUpdateState("available");
      } else {
        setUpdateState("uptodate");
      }
    } catch (e: any) {
      setUpdateError(String(e));
      setUpdateState("error");
    }
  };

  const downloadUpdate = async () => {
    if (!updateInfo?.download_url) return;
    setUpdateState("downloading");
    setUpdateError("");
    try {
      const path = await invoke<string>("download_update", {
        downloadUrl: updateInfo.download_url,
      });
      setLocalPath(path);
      setUpdateState("downloaded");
    } catch (e: any) {
      setUpdateError(String(e));
      setUpdateState("error");
    }
  };

  const installUpdate = async () => {
    if (!localPath) return;
    // 后端会打开安装包并退出当前进程，前端无需等待结果
    invoke("install_update", { path: localPath }).catch(() => {});
  };

  useEffect(() => {
    invoke<{ version: string; dataDir: string; homeDir?: string }>("get_app_info")
      .then((info) =>
        setAppInfo({
          version: info.version,
          dataDir: typeof info.dataDir === "string" ? info.dataDir : String(info.dataDir),
          homeDir: info.homeDir
            ? typeof info.homeDir === "string"
              ? info.homeDir
              : String(info.homeDir)
            : "",
        })
      )
      .catch(() => {});
  }, []);

  const updateTerminal = (patch: Partial<AppSettings["terminal"]>) => {
    setSettings({ terminal: { ...settings.terminal, ...patch } });
  };

  const handleReset = async () => {
    const ok = await askConfirm({
      title: "重置设置",
      message: "将所有设置恢复为默认值，确定吗？",
      confirmText: "重置",
    });
    if (ok) {
      reset();
      toast.success("已重置");
    }
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div
        className="modal"
        onClick={(e) => e.stopPropagation()}
        style={{ width: 640, height: 500 }}
      >
        <div className="modal-header">
          <span>设置</span>
          <button className="btn btn-ghost btn-icon" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        <div className="settings-tabs">
          <div
            className={`settings-tab ${tab === "appearance" ? "active" : ""}`}
            onClick={() => setTab("appearance")}
          >
            外观
          </div>
          <div
            className={`settings-tab ${tab === "terminal" ? "active" : ""}`}
            onClick={() => setTab("terminal")}
          >
            终端
          </div>
          <div
            className={`settings-tab ${tab === "files" ? "active" : ""}`}
            onClick={() => setTab("files")}
          >
            文件传输
          </div>
          <div
            className={`settings-tab ${tab === "security" ? "active" : ""}`}
            onClick={() => setTab("security")}
          >
            安全
          </div>
          <div
            className={`settings-tab ${tab === "about" ? "active" : ""}`}
            onClick={() => setTab("about")}
          >
            关于
          </div>
        </div>
        <div className="modal-body">
          {tab === "appearance" && (
            <div>
              <div className="settings-section">
                <div className="settings-section-title">主题</div>
                <div className="theme-cards">
                  {THEME_OPTIONS.map((opt) => (
                    <div
                      key={opt.value}
                      className={`theme-card ${settings.theme === opt.value ? "active" : ""}`}
                      onClick={() => setSettings({ theme: opt.value })}
                    >
                      <div className={`theme-preview ${opt.value}`}>
                        <span className="tp-side" />
                        <span className="tp-main">
                          <span className="tp-bar" />
                          <span className="tp-line" />
                          <span className="tp-line short" />
                        </span>
                      </div>
                      <div className="theme-card-label">{opt.label}</div>
                    </div>
                  ))}
                </div>
                <div className="settings-info" style={{ marginTop: 10 }}>
                  当前生效：{effectiveTheme === "light" ? "亮色" : "暗色"}
                  {settings.theme === "system" && "（跟随系统）"}
                </div>
              </div>
            </div>
          )}

          {tab === "terminal" && (
            <div>
              <div className="settings-section">
                <div className="settings-section-title">字体</div>
                <div className="settings-row">
                  <label>字体大小</label>
                  <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                    {FONT_SIZES.map((s) => (
                      <button
                        key={s}
                        className={`btn btn-sm ${settings.terminal.fontSize === s ? "btn-primary" : ""}`}
                        onClick={() => updateTerminal({ fontSize: s })}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="settings-row">
                  <label>字体</label>
                  <select
                    className="select"
                    value={settings.terminal.fontFamily}
                    onChange={(e) => updateTerminal({ fontFamily: e.target.value })}
                  >
                    <option value="&quot;JetBrains Mono&quot;, &quot;Cascadia Code&quot;, &quot;SF Mono&quot;, Consolas, monospace">JetBrains Mono</option>
                    <option value="&quot;Cascadia Code&quot;, Consolas, monospace">Cascadia Code</option>
                    <option value="&quot;SF Mono&quot;, &quot;JetBrains Mono&quot;, Menlo, monospace">SF Mono</option>
                    <option value="Consolas, &quot;Courier New&quot;, monospace">Consolas</option>
                    <option value="&quot;Courier New&quot;, monospace">Courier New</option>
                    <option value="Menlo, Monaco, monospace">Menlo</option>
                    <option value="&quot;Microsoft YaHei Mono&quot;, &quot;PingFang SC&quot;, monospace">Microsoft YaHei Mono</option>
                  </select>
                </div>
              </div>

              <div className="settings-section">
                <div className="settings-section-title">颜色</div>
                <div className="settings-row">
                  <label>文字颜色</label>
                  <div className="settings-color-row">
                    {FG_COLORS.map((c) => (
                      <span
                        key={c.value}
                        className={`settings-color-swatch ${settings.terminal.foreground === c.value ? "active" : ""}`}
                        style={{ background: c.value }}
                        onClick={() => updateTerminal({ foreground: c.value })}
                        title={c.name}
                      />
                    ))}
                  </div>
                </div>
                <div className="settings-row">
                  <label>光标颜色</label>
                  <div className="settings-color-row">
                    {COLORS.map((c) => (
                      <span
                        key={c.value}
                        className={`settings-color-swatch ${settings.terminal.cursorColor === c.value ? "active" : ""}`}
                        style={{ background: c.value }}
                        onClick={() => updateTerminal({ cursorColor: c.value })}
                        title={c.name}
                      />
                    ))}
                  </div>
                </div>
                <div className="settings-row">
                  <label>光标闪烁</label>
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={settings.terminal.cursorBlink}
                      onChange={(e) => updateTerminal({ cursorBlink: e.target.checked })}
                    />
                    启用
                  </label>
                </div>
              </div>
            </div>
          )}

          {tab === "files" && (
            <div>
              <div className="settings-section">
                <div className="settings-section-title">文件传输</div>
                <div className="settings-row">
                  <label>覆盖确认</label>
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={settings.transfers.confirmOverwrite}
                      onChange={(e) =>
                        setSettings({
                          transfers: { confirmOverwrite: e.target.checked },
                        })
                      }
                    />
                    目标文件已存在时询问
                  </label>
                </div>
              </div>

              <div className="settings-section">
                <div className="settings-section-title">默认打开应用</div>
                <div className="settings-info">
                  在 SFTP 文件上右键 → "打开方式" 时可保存默认应用，
                  系统将按文件后缀自动调用。
                </div>
                <div style={{ marginTop: 10 }}>
                  {Object.keys(settings.defaultApps).length === 0 ? (
                    <div className="text-muted text-sm" style={{ padding: 8 }}>
                      暂无配置
                    </div>
                  ) : (
                    Object.entries(settings.defaultApps).map(([ext, path]) => (
                      <div
                        key={ext}
                        className="settings-data-row"
                        style={{ marginBottom: 4 }}
                      >
                        <span>.{ext}</span>
                        <span
                          style={{
                            color: "var(--fg-secondary)",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            maxWidth: 280,
                          }}
                        >
                          {path}
                        </span>
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => {
                            const next = { ...settings.defaultApps };
                            delete next[ext];
                            setSettings({ defaultApps: next });
                          }}
                        >
                          删除
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          )}

          {tab === "security" && (
            <div>
              <div className="settings-section">
                <div className="settings-section-title">
                  已信任的主机密钥
                  <span
                    style={{
                      marginLeft: 8,
                      fontSize: 11,
                      fontWeight: 400,
                      color: "var(--fg-muted)",
                    }}
                  >
                    共 {hosts.length} 条
                  </span>
                </div>
                <div
                  style={{
                    fontSize: 11,
                    color: "var(--fg-muted)",
                    marginBottom: 10,
                    lineHeight: 1.6,
                  }}
                >
                  首次连接 SSH 服务器时会自动记录其公钥指纹（TOFU）。之后若指纹发生变化，
                  连接会被拒绝以防止中间人攻击。确认服务器确实更换了密钥时，删除对应记录即可重新信任。
                </div>

                <div className="host-key-list">
                  {hostsLoading ? (
                    <div className="host-key-empty">加载中…</div>
                  ) : hosts.length === 0 ? (
                    <div className="host-key-empty">暂无记录</div>
                  ) : (
                    hosts.map((h) => (
                      <div className="host-key-item" key={`${h.host}:${h.port}`}>
                        <div className="host-key-main">
                          <div className="host-key-addr">
                            {h.host}
                            <span className="host-key-port">:{h.port}</span>
                            <span className="host-key-type">{h.keyType}</span>
                          </div>
                          <div className="host-key-fp" title={h.fingerprint}>
                            {h.fingerprint}
                          </div>
                          <div className="host-key-time">
                            首次信任 {formatHostTime(h.addedAt)}
                          </div>
                        </div>
                        <div className="host-key-actions">
                          <button
                            className="btn btn-ghost btn-sm"
                            onClick={() => copyFingerprint(h.fingerprint)}
                          >
                            复制
                          </button>
                          <button
                            className="btn btn-ghost btn-sm danger"
                            onClick={() => removeHost(h.host, h.port)}
                          >
                            删除
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>

                <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                  <button className="btn btn-ghost btn-sm" onClick={loadHosts}>
                    刷新
                  </button>
                  <button
                    className="btn btn-ghost btn-sm danger"
                    onClick={clearHosts}
                    disabled={hosts.length === 0}
                  >
                    清空全部
                  </button>
                </div>
              </div>
            </div>
          )}

          {tab === "about" && (
            <div>
              <div style={{ textAlign: "center", marginBottom: 20 }}>
                <div
                  style={{
                    fontSize: 22,
                    fontWeight: 700,
                    background: "var(--gradient-primary)",
                    WebkitBackgroundClip: "text",
                    WebkitTextFillColor: "transparent",
                    marginBottom: 4,
                  }}
                >
                  Shelflux
                </div>
                <div style={{ fontSize: 12, color: "var(--fg-muted)" }}>
                  轻量化、跨平台的多协议连接管理工具
                </div>
              </div>

              <div className="settings-section">
                <div className="settings-section-title">版本</div>
                <div className="settings-data-row">
                  <span>应用版本</span>
                  <span>{appInfo?.version || "-"}</span>
                </div>
                <div className="settings-data-row" style={{ marginTop: 4 }}>
                  <span>数据目录</span>
                  <span
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      maxWidth: 360,
                    }}
                    title={appInfo?.dataDir}
                  >
                    {appInfo?.dataDir || "-"}
                  </span>
                </div>
              </div>

              <div className="settings-section">
                <div className="settings-section-title">更新</div>
                <div className="settings-data-row" style={{ marginBottom: 8 }}>
                  <span>更新状态</span>
                  <span>
                    {updateState === "idle" && "—"}
                    {updateState === "checking" && "正在检查…"}
                    {updateState === "uptodate" && `已是最新 (v${appInfo?.version})`}
                    {updateState === "available" && `发现新版本 v${updateInfo?.latest_version}`}
                    {updateState === "downloading" && "正在下载…"}
                    {updateState === "downloaded" && "下载完成，可安装"}
                    {updateState === "error" && "检查失败"}
                  </span>
                </div>

                {updateState === "available" && (
                  <div className="settings-info" style={{ marginBottom: 8 }}>
                    新版本 v{updateInfo?.latest_version} 可用（当前 v{appInfo?.version}）
                    {updateInfo?.size
                      ? ` · ${(updateInfo.size / 1048576).toFixed(1)} MB`
                      : ""}
                  </div>
                )}

                {updateState === "error" && (
                  <div
                    className="settings-info"
                    style={{ marginBottom: 8, color: "var(--color-error)" }}
                  >
                    {updateError}
                  </div>
                )}

                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {(updateState === "idle" ||
                    updateState === "uptodate" ||
                    updateState === "error") && (
                    <button className="btn btn-sm" onClick={checkUpdate}>
                      检查更新
                    </button>
                  )}
                  {updateState === "available" && (
                    <button className="btn btn-sm btn-primary" onClick={downloadUpdate}>
                      下载
                    </button>
                  )}
                  {updateState === "downloading" && (
                    <button className="btn btn-sm" disabled>
                      下载中…
                    </button>
                  )}
                  {updateState === "downloaded" && (
                    <button className="btn btn-sm btn-primary" onClick={installUpdate}>
                      安装
                    </button>
                  )}
                </div>

                {updateState === "available" && updateInfo?.release_notes && (
                  <div
                    style={{
                      marginTop: 10,
                      fontSize: 12,
                      color: "var(--fg-secondary)",
                      whiteSpace: "pre-wrap",
                      maxHeight: 120,
                      overflow: "auto",
                      background: "var(--bg-secondary)",
                      padding: 8,
                      borderRadius: 6,
                    }}
                  >
                    {updateInfo.release_notes}
                  </div>
                )}
              </div>

              <div className="settings-section">
                <div className="settings-section-title">支持</div>
                <div className="settings-info">
                  支持 SSH / SFTP / Telnet / Rlogin 协议
                  <br />
                  完全离线运行，所有数据存储在本地
                  <br />
                  由 Tauri + React + Rust 构建
                </div>
              </div>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-danger" onClick={handleReset}>
            重置全部
          </button>
          <div style={{ flex: 1 }} />
          <button className="btn btn-primary" onClick={onClose}>
            完成
          </button>
        </div>
      </div>
    </div>
  );
}

function CloseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
