// 端口转发管理面板
// 支持本地转发（-L）、远程转发（-R）、动态转发（-D，SOCKS5）
import { useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useForwardStore } from "../../stores/forwardStore";
import { useServerStore } from "../../stores/serverStore";
import { useUiStore } from "../../stores/uiStore";
import { toast } from "../../stores/toastStore";
import type { ForwardKind, ForwardRuntime, PortForward } from "../../types";
import { DEFAULT_FORWARD } from "../../types";
import "./ForwardPanel.css";

interface Props {
  onClose: () => void;
}

const KIND_LABEL: Record<ForwardKind, string> = {
  local: "本地转发",
  remote: "远程转发",
  dynamic: "动态转发",
};

const KIND_HINT: Record<ForwardKind, string> = {
  local: "本机监听端口，流量经 SSH 转发到目标地址（等价 ssh -L）",
  remote: "服务端监听端口，流量回连到本机可达的目标（等价 ssh -R）",
  dynamic: "本机监听为 SOCKS5 代理，目标由客户端动态指定（等价 ssh -D）",
};

/** 生成一行人类可读的转发路径描述 */
function describe(rule: PortForward): string {
  const bind = `${rule.bindAddr || "127.0.0.1"}:${rule.bindPort}`;
  if (rule.kind === "dynamic") return `SOCKS5 ${bind}`;
  const dest = `${rule.destHost}:${rule.destPort}`;
  return rule.kind === "local" ? `${bind} → ${dest}` : `远端 ${bind} → ${dest}`;
}

export function ForwardPanel({ onClose }: Props) {
  const rules = useForwardStore((s) => s.rules);
  const runtime = useForwardStore((s) => s.runtime);
  const addRule = useForwardStore((s) => s.addRule);
  const updateRule = useForwardStore((s) => s.updateRule);
  const removeRule = useForwardStore((s) => s.removeRule);
  const applyRuntime = useForwardStore((s) => s.applyRuntime);
  const syncRuntime = useForwardStore((s) => s.syncRuntime);
  const startFwd = useForwardStore((s) => s.start);
  const stopFwd = useForwardStore((s) => s.stop);

  const servers = useServerStore((s) => s.servers);
  const askConfirm = useUiStore((s) => s.askConfirm);

  const [editing, setEditing] = useState<PortForward | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // 仅 SSH/SFTP 服务器支持端口转发
  const sshServers = useMemo(
    () => servers.filter((s) => s.protocol === "ssh" || s.protocol === "sftp"),
    [servers]
  );

  useEffect(() => {
    void syncRuntime();
    const un = listen<ForwardRuntime>("forward-status", (e) =>
      applyRuntime(e.payload)
    );
    return () => {
      void un.then((f) => f());
    };
  }, [applyRuntime, syncRuntime]);

  const serverName = (id: string) => {
    const s = servers.find((x) => x.id === id);
    if (!s) return "（服务器已删除）";
    return s.alias || `${s.username}@${s.host}`;
  };

  const toggle = async (rule: PortForward) => {
    const rt = runtime[rule.id];
    setBusyId(rule.id);
    try {
      if (rt?.active) {
        await stopFwd(rule.id);
        toast.success("已停止", describe(rule));
      } else {
        const server = servers.find((s) => s.id === rule.serverId);
        if (!server) {
          toast.error("启动失败", "关联的服务器不存在，请重新选择");
          return;
        }
        await startFwd(rule, server);
        toast.success("已启动", describe(rule));
      }
    } catch (e: any) {
      toast.error("操作失败", e.toString());
    } finally {
      setBusyId(null);
    }
  };

  const del = async (rule: PortForward) => {
    const ok = await askConfirm({
      title: "删除转发规则",
      message: `确定删除 "${rule.name || describe(rule)}" 吗？`,
      confirmText: "删除",
      danger: true,
    });
    if (!ok) return;
    if (runtime[rule.id]?.active) {
      try {
        await stopFwd(rule.id);
      } catch {
        /* 忽略停止失败，继续删除规则 */
      }
    }
    removeRule(rule.id);
    toast.success("已删除");
  };

  const openNew = () => {
    if (sshServers.length === 0) {
      toast.warn("暂无可用服务器", "端口转发需要先添加 SSH/SFTP 服务器");
      return;
    }
    setEditing({
      ...DEFAULT_FORWARD,
      id: "",
      serverId: sshServers[0].id,
    } as PortForward);
  };

  const save = (rule: PortForward) => {
    const err = validate(rule);
    if (err) {
      toast.error("配置有误", err);
      return;
    }
    if (rule.id) {
      updateRule(rule.id, rule);
      toast.success("已保存");
    } else {
      addRule(rule);
      toast.success("已添加");
    }
    setEditing(null);
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div
        className="modal"
        onClick={(e) => e.stopPropagation()}
        style={{ width: 720, height: 540 }}
      >
        <div className="modal-header">
          <span>端口转发</span>
          <button className="btn btn-ghost btn-icon" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>

        <div className="modal-body fwd-body">
          {editing ? (
            <ForwardForm
              value={editing}
              servers={sshServers}
              onChange={setEditing}
              onCancel={() => setEditing(null)}
              onSave={save}
            />
          ) : (
            <>
              <div className="fwd-toolbar">
                <button className="btn btn-primary btn-sm" onClick={openNew}>
                  新建规则
                </button>
                <div className="fwd-toolbar-spacer" />
                <span className="fwd-count">
                  {rules.length} 条规则 ·{" "}
                  {Object.values(runtime).filter((r) => r.active).length} 条运行中
                </span>
              </div>

              {rules.length === 0 ? (
                <div className="fwd-empty">
                  <div className="fwd-empty-title">还没有转发规则</div>
                  <div className="fwd-empty-desc">
                    端口转发可以把远端服务安全地映射到本机，或反向暴露本机服务。
                  </div>
                </div>
              ) : (
                <div className="fwd-list">
                  {rules.map((rule) => {
                    const rt = runtime[rule.id];
                    const active = !!rt?.active;
                    return (
                      <div
                        className={`fwd-item ${active ? "active" : ""}`}
                        key={rule.id}
                      >
                        <div className={`fwd-dot ${active ? "on" : ""}`} />
                        <div className="fwd-main">
                          <div className="fwd-title">
                            {rule.name || KIND_LABEL[rule.kind]}
                            <span className={`fwd-kind ${rule.kind}`}>
                              {KIND_LABEL[rule.kind]}
                            </span>
                            {active && rt.connections > 0 && (
                              <span className="fwd-conns">
                                {rt.connections} 连接
                              </span>
                            )}
                          </div>
                          <div className="fwd-path">{describe(rule)}</div>
                          <div className="fwd-server">
                            {serverName(rule.serverId)}
                          </div>
                          {rt?.error && (
                            <div className="fwd-error">{rt.error}</div>
                          )}
                        </div>
                        <div className="fwd-actions">
                          <button
                            className={`btn btn-sm ${
                              active ? "btn-ghost" : "btn-primary"
                            }`}
                            disabled={busyId === rule.id}
                            onClick={() => toggle(rule)}
                          >
                            {busyId === rule.id
                              ? "…"
                              : active
                              ? "停止"
                              : "启动"}
                          </button>
                          <button
                            className="btn btn-ghost btn-sm"
                            disabled={active}
                            title={active ? "请先停止后再编辑" : ""}
                            onClick={() => setEditing({ ...rule })}
                          >
                            编辑
                          </button>
                          <button
                            className="btn btn-ghost btn-sm danger"
                            onClick={() => del(rule)}
                          >
                            删除
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------- 表单 ------------------------------- */

function validate(r: PortForward): string | null {
  if (!r.serverId) return "请选择服务器";
  if (!r.bindPort || r.bindPort < 0 || r.bindPort > 65535)
    return "监听端口需在 0–65535 之间";
  if (r.kind !== "dynamic") {
    if (!r.destHost.trim()) return "请填写目标主机";
    if (!r.destPort || r.destPort < 1 || r.destPort > 65535)
      return "目标端口需在 1–65535 之间";
  }
  if (r.kind !== "remote" && r.bindPort === 0)
    return "本地/动态转发的监听端口不能为 0";
  return null;
}

function ForwardForm({
  value,
  servers,
  onChange,
  onCancel,
  onSave,
}: {
  value: PortForward;
  servers: { id: string; alias?: string; host: string; username: string }[];
  onChange: (v: PortForward) => void;
  onCancel: () => void;
  onSave: (v: PortForward) => void;
}) {
  const set = (patch: Partial<PortForward>) => onChange({ ...value, ...patch });
  const isDynamic = value.kind === "dynamic";
  const isRemote = value.kind === "remote";

  return (
    <div className="fwd-form">
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 10,
          marginBottom: 10,
        }}
      >
        <div>
          <div className="label">规则名称</div>
          <input
            className="input"
            value={value.name}
            placeholder="可选，便于识别"
            onChange={(e) => set({ name: e.target.value })}
          />
        </div>
        <div>
          <div className="label">服务器 *</div>
          <select
            className="select"
            value={value.serverId}
            onChange={(e) => set({ serverId: e.target.value })}
          >
            {servers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.alias || `${s.username}@${s.host}`}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div style={{ marginBottom: 10 }}>
        <div className="label">转发类型</div>
        <div className="fwd-kind-cards">
          {(["local", "remote", "dynamic"] as ForwardKind[]).map((k) => (
            <div
              key={k}
              className={`fwd-kind-card ${value.kind === k ? "active" : ""}`}
              onClick={() => set({ kind: k })}
            >
              <div className="fwd-kind-name">{KIND_LABEL[k]}</div>
              <div className="fwd-kind-desc">{KIND_HINT[k]}</div>
            </div>
          ))}
        </div>
      </div>

      <div style={{ marginBottom: 10 }}>
        <div className="label">{isRemote ? "服务端监听" : "本机监听"} *</div>
        <div className="fwd-addr-row">
          <input
            className="input"
            style={{ flex: 2 }}
            value={value.bindAddr}
            placeholder={isRemote ? "127.0.0.1 / 0.0.0.0" : "127.0.0.1"}
            onChange={(e) => set({ bindAddr: e.target.value })}
          />
          <span className="fwd-colon">:</span>
          <input
            className="input"
            style={{ flex: 1 }}
            type="number"
            min={0}
            max={65535}
            value={value.bindPort}
            onChange={(e) => set({ bindPort: Number(e.target.value) })}
          />
        </div>
        <div className="fwd-hint">
          {isRemote
            ? "监听 0.0.0.0 需要服务端开启 GatewayPorts；端口填 0 由服务端自动分配"
            : "监听 0.0.0.0 会让局域网内其他设备也能访问，请谨慎"}
        </div>
      </div>

      {!isDynamic && (
        <div style={{ marginBottom: 10 }}>
          <div className="label">{isRemote ? "回连目标" : "转发目标"} *</div>
          <div className="fwd-addr-row">
            <input
              className="input"
              style={{ flex: 2 }}
              value={value.destHost}
              placeholder="127.0.0.1"
              onChange={(e) => set({ destHost: e.target.value })}
            />
            <span className="fwd-colon">:</span>
            <input
              className="input"
              style={{ flex: 1 }}
              type="number"
              min={1}
              max={65535}
              value={value.destPort}
              onChange={(e) => set({ destPort: Number(e.target.value) })}
            />
          </div>
          <div className="fwd-hint">
            {isRemote
              ? "从本机视角可达的地址，SSH 服务端的连接会被转发到这里"
              : "从 SSH 服务端视角可达的地址"}
          </div>
        </div>
      )}

      <div className="fwd-form-actions">
        <button className="btn btn-ghost" onClick={onCancel}>
          取消
        </button>
        <button className="btn btn-primary" onClick={() => onSave(value)}>
          保存
        </button>
      </div>
    </div>
  );
}

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}
