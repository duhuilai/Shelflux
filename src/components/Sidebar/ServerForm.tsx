// 服务器创建/编辑表单
import { useEffect, useState } from "react";
import type { Server, Protocol, ProxyConfig } from "../../types";
import { DEFAULT_PROXY } from "../../types";
import { useServerStore } from "../../stores/serverStore";
import { useUiStore } from "../../stores/uiStore";
import { toast } from "../../stores/toastStore";
import { basename } from "../../utils/format";
import { invoke } from "@tauri-apps/api/core";

interface Props {
  onClose: () => void;
}

const PROTOCOL_PRESETS: Record<Protocol, { port: number; label: string; color: string }> = {
  ssh: { port: 22, label: "SSH 终端", color: "var(--accent-blue)" },
  sftp: { port: 22, label: "SFTP 文件传输", color: "var(--accent-violet)" },
  telnet: { port: 23, label: "Telnet", color: "var(--accent-yellow)" },
  rlogin: { port: 513, label: "Rlogin", color: "var(--accent-cyan)" },
};

export function ServerForm({ onClose }: Props) {
  const { editing, groupId: presetGroupId } = useUiStore((s) => s.serverForm);
  const groups = useServerStore((s) => s.groups);
  const addServer = useServerStore((s) => s.addServer);
  const updateServer = useServerStore((s) => s.updateServer);

  const isEdit = !!editing;
  const [form, setForm] = useState<Partial<Server>>(() => {
    if (editing) return { ...editing };
    return {
      protocol: "ssh" as Protocol,
      port: 22,
      username: "",
      host: "",
      password: "",
      privateKey: "",
      passphrase: "",
      alias: "",
      groupId: presetGroupId ?? null,
      defaultRemotePath: "/",
      defaultLocalPath: "",
    };
  });
  const [authTab, setAuthTab] = useState<"password" | "key">("password");
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    if (editing?.privateKey) setAuthTab("key");
  }, [editing]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.host || !form.username) {
      toast.error("请填写主机和用户名");
      return;
    }
    if (form.proxy && form.proxy.kind !== "none") {
      if (!form.proxy.host.trim()) {
        toast.error("请填写代理主机");
        return;
      }
      if (!form.proxy.port || form.proxy.port < 1 || form.proxy.port > 65535) {
        toast.error("代理端口需在 1–65535 之间");
        return;
      }
    }
    if (!isEdit && !form.id) {
      const created = addServer(form as Omit<Server, "id">);
      toast.success("已创建", created.alias || created.host);
    } else {
      updateServer(editing!.id, form);
      toast.success("已保存");
    }
    onClose();
  };

  const setField = <K extends keyof Server>(key: K, val: Server[K]) => {
    setForm((f) => ({ ...f, [key]: val }));
  };

  const proxy: ProxyConfig = form.proxy ?? DEFAULT_PROXY;
  const setProxy = (patch: Partial<ProxyConfig>) => {
    const next = { ...proxy, ...patch };
    // kind=none 时不必留存冗余配置
    setForm((f) => ({ ...f, proxy: next.kind === "none" ? undefined : next }));
  };

  const canTest = !!(form.host && form.username);

  // 测试连接：组装一个临时 ServerConfig 直接交给后端，不写入连接池
  const handleTest = async () => {
    if (!canTest) {
      toast.error("请先填写主机和用户名");
      return;
    }
    setTesting(true);
    try {
      const payload = {
        id: "__test__",
        protocol: form.protocol,
        host: form.host,
        port: form.port || 0,
        username: form.username,
        password: form.password || "",
        privateKey: form.privateKey || "",
        passphrase: form.passphrase || "",
        proxy: form.proxy ?? null,
      };
      const res = (await invoke<any>("test_connection", { server: payload })) as {
        success: boolean;
        message: string;
        fingerprint?: string;
      };
      if (res?.success) {
        toast.success("连接成功", res.message + (res.fingerprint ? ` · 主机指纹 ${res.fingerprint}` : ""));
      } else {
        toast.error("连接失败", res?.message || "未知错误");
      }
    } catch (e: any) {
      toast.error("连接失败", e?.toString ? e.toString() : String(e));
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <form className="modal server-form-modal" onClick={(e) => e.stopPropagation()} onSubmit={handleSubmit} style={{ width: 520 }}>
        <div className="modal-header">
          <span>{isEdit ? "编辑服务器" : "新建服务器"}</span>
          <button type="button" className="btn btn-ghost btn-icon" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        <div className="modal-body">
          {/* 协议选择 */}
          <div className="label">协议</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6, marginBottom: 14 }}>
            {(Object.keys(PROTOCOL_PRESETS) as Protocol[]).map((p) => {
              const preset = PROTOCOL_PRESETS[p];
              const active = form.protocol === p;
              return (
                <button
                  key={p}
                  type="button"
                  onClick={() => {
                    setField("protocol", p);
                    if (!form.port || PROTOCOL_PRESETS[form.protocol as Protocol]?.port === form.port) {
                      setField("port", preset.port);
                    }
                  }}
                  style={{
                    padding: "8px 4px",
                    background: active ? preset.color + "22" : "rgba(255,255,255,0.03)",
                    border: `1px solid ${active ? preset.color : "var(--border-soft)"}`,
                    borderRadius: 6,
                    color: active ? preset.color : "var(--fg-secondary)",
                    cursor: "pointer",
                    fontSize: 12,
                    fontWeight: 500,
                    transition: "all 0.2s",
                  }}
                >
                  {preset.label}
                </button>
              );
            })}
          </div>

          {/* 别名 */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
            <div>
              <div className="label">别名（可选）</div>
              <input
                className="input"
                placeholder="生产服务器"
                value={form.alias || ""}
                onChange={(e) => setField("alias", e.target.value)}
              />
            </div>
            <div>
              <div className="label">分组</div>
              <select
                className="select"
                value={form.groupId || ""}
                onChange={(e) =>
                  setField("groupId", e.target.value || null)
                }
              >
                <option value="">未分组</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* 主机 / 端口 */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 100px", gap: 10, marginBottom: 10 }}>
            <div>
              <div className="label">主机 *</div>
              <input
                className="input"
                placeholder="192.168.1.10 或 example.com"
                value={form.host || ""}
                onChange={(e) => setField("host", e.target.value)}
                required
              />
            </div>
            <div>
              <div className="label">端口</div>
              <input
                className="input"
                type="number"
                value={form.port || 0}
                onChange={(e) => setField("port", parseInt(e.target.value) || 0)}
              />
            </div>
          </div>

          <div style={{ marginBottom: 10 }}>
            <div className="label">用户名 *</div>
            <input
              className="input"
              placeholder="root"
              value={form.username || ""}
              onChange={(e) => setField("username", e.target.value)}
              required
            />
          </div>

          {/* 认证方式 */}
          {form.protocol !== "telnet" && form.protocol !== "rlogin" && (
            <>
              <div style={{ display: "flex", gap: 12, marginBottom: 8, marginTop: 14 }}>
                <label className="checkbox">
                  <input
                    type="radio"
                    checked={authTab === "password"}
                    onChange={() => setAuthTab("password")}
                  />
                  密码
                </label>
                <label className="checkbox">
                  <input
                    type="radio"
                    checked={authTab === "key"}
                    onChange={() => setAuthTab("key")}
                  />
                  私钥
                </label>
              </div>

              {authTab === "password" ? (
                <PasswordInput
                  label="密码"
                  placeholder="••••••••"
                  value={form.password || ""}
                  onChange={(v) => setField("password", v)}
                />
              ) : (
                <>
                  <div style={{ marginBottom: 10 }}>
                    <div className="label">私钥（PEM 文本）</div>
                    <textarea
                      className="textarea"
                      rows={4}
                      placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;..."
                      value={form.privateKey || ""}
                      onChange={(e) => setField("privateKey", e.target.value)}
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: 11,
                        resize: "vertical",
                      }}
                    />
                  </div>
                <PasswordInput
                  label="私钥口令（可选）"
                  value={form.passphrase || ""}
                  onChange={(v) => setField("passphrase", v)}
                />
                </>
              )}
            </>
          )}

          {/* 默认路径 */}
          {form.protocol === "sftp" && (
            <>
              <div style={{ marginTop: 14, marginBottom: 6, fontSize: 12, color: "var(--fg-secondary)", fontWeight: 600 }}>
                默认打开路径
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <div>
                  <div className="label">本地</div>
                  <input
                    className="input"
                    placeholder="C:\Users\xxx"
                    value={form.defaultLocalPath || ""}
                    onChange={(e) => setField("defaultLocalPath", e.target.value)}
                  />
                </div>
                <div>
                  <div className="label">远端</div>
                  <input
                    className="input"
                    placeholder="/home/user"
                    value={form.defaultRemotePath || ""}
                    onChange={(e) => setField("defaultRemotePath", e.target.value)}
                  />
                </div>
              </div>
            </>
          )}

          {/* 代理 */}
          <div
            style={{
              marginTop: 14,
              marginBottom: 6,
              fontSize: 12,
              color: "var(--fg-secondary)",
              fontWeight: 600,
            }}
          >
            代理
          </div>
          <div className="label">类型</div>
          <select
            className="select"
            value={proxy.kind}
            onChange={(e) =>
              setProxy({ kind: e.target.value as ProxyConfig["kind"] })
            }
          >
            <option value="none">不使用代理（直连）</option>
            <option value="http">HTTP CONNECT</option>
            <option value="socks5">SOCKS5</option>
          </select>

          {proxy.kind !== "none" && (
            <>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 100px",
                  gap: 10,
                  marginTop: 10,
                }}
              >
                <div>
                  <div className="label">代理主机 *</div>
                  <input
                    className="input"
                    placeholder="127.0.0.1"
                    value={proxy.host}
                    onChange={(e) => setProxy({ host: e.target.value })}
                  />
                </div>
                <div>
                  <div className="label">端口</div>
                  <input
                    className="input"
                    type="number"
                    value={proxy.port}
                    onChange={(e) =>
                      setProxy({ port: parseInt(e.target.value) || 0 })
                    }
                  />
                </div>
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: 10,
                  marginTop: 10,
                }}
              >
                <div>
                  <div className="label">用户名（可选）</div>
                  <input
                    className="input"
                    value={proxy.username || ""}
                    onChange={(e) => setProxy({ username: e.target.value })}
                  />
                </div>
                <PasswordInput
                  label="密码（可选）"
                  value={proxy.password || ""}
                  onChange={(v) => setProxy({ password: v })}
                />
              </div>
              <div
                style={{
                  marginTop: 6,
                  fontSize: 10.5,
                  color: "var(--fg-muted)",
                  lineHeight: 1.6,
                }}
              >
                所有连接（终端、SFTP、端口转发）都会先经过该代理再连到目标服务器。
              </div>
            </>
          )}
        </div>
        <div className="modal-footer">
          <button
            type="button"
            className="btn"
            style={{ marginRight: "auto" }}
            onClick={handleTest}
            disabled={testing || !canTest}
            title={canTest ? "使用当前填写的主机、认证与代理信息测试连通性" : "请先填写主机和用户名"}
          >
            {testing ? "测试中…" : "测试连接"}
          </button>
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="btn btn-primary">
            {isEdit ? "保存" : "创建"}
          </button>
        </div>
      </form>
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

// ── 带明文切换（眼睛图标）的密码输入框 ──
function PasswordInput({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <div style={{ marginBottom: 10 }}>
      <div className="label">{label}</div>
      <div style={{ position: "relative" }}>
        <input
          className="input"
          type={show ? "text" : "password"}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          style={{ paddingRight: 30 }}
        />
        <button
          type="button"
          onClick={() => setShow((s) => !s)}
          title={show ? "隐藏密码" : "显示明文"}
          aria-label={show ? "隐藏密码" : "显示明文"}
          style={{
            position: "absolute",
            right: 4,
            top: "50%",
            transform: "translateY(-50%)",
            background: "transparent",
            border: "none",
            cursor: "pointer",
            color: "var(--fg-muted)",
            padding: 4,
            display: "flex",
            borderRadius: 4,
          }}
        >
          {show ? <EyeOffIcon /> : <EyeIcon />}
        </button>
      </div>
    </div>
  );
}

function EyeIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
      <path
        d="M1 8s2.3-4.5 7-4.5S15 8 15 8s-2.3 4.5-7 4.5S1 8 1 8z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="8" r="2.1" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
      <path
        d="M1 8s2.3-4.5 7-4.5c1.2 0 2.3.3 3.2.8M14.2 6.6C14.7 7.2 15 8 15 8s-2.3 4.5-7 4.5c-1 0-1.9-.2-2.7-.6"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M2.5 2.5l11 11" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="8" cy="8" r="2.1" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}
