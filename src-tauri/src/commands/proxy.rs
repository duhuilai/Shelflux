// 代理支持：HTTP CONNECT 隧道 与 SOCKS5（RFC 1928 / RFC 1929）
//
// 对外只暴露 `connect_tcp`：给定目标 host:port 与服务器配置，返回一条
// 已经"打通"到目标的 TcpStream。上层（russh / Telnet / Rlogin）无需关心
// 中间是否经过代理。

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use crate::error::AppError;
use crate::types::{ProxyConfig, ServerConfig};

/// 按服务器配置建立到 `host:port` 的 TCP 连接（可能经由代理）
pub async fn connect_tcp(server: &ServerConfig) -> Result<TcpStream, AppError> {
    let host = server.host.clone();
    let port = server.effective_port();
    match server.proxy.as_ref() {
        Some(p) if p.is_enabled() => connect_via_proxy(p, &host, port).await,
        _ => direct(&host, port).await,
    }
}

async fn direct(host: &str, port: u16) -> Result<TcpStream, AppError> {
    let addr = format!("{host}:{port}");
    TcpStream::connect(&addr)
        .await
        .map_err(|e| AppError::Other(format!("无法连接到 {addr}: {e}")))
}

async fn connect_via_proxy(
    proxy: &ProxyConfig,
    host: &str,
    port: u16,
) -> Result<TcpStream, AppError> {
    let paddr = format!("{}:{}", proxy.host, proxy.port);
    let stream = TcpStream::connect(&paddr)
        .await
        .map_err(|e| AppError::Other(format!("无法连接代理 {paddr}: {e}")))?;
    let _ = stream.set_nodelay(true);

    match proxy.kind.as_str() {
        "http" => http_connect(stream, proxy, host, port).await,
        "socks5" => socks5_connect(stream, proxy, host, port).await,
        other => Err(AppError::Other(format!("不支持的代理类型: {other}"))),
    }
}

// ---------------------------------------------------------------------------
// HTTP CONNECT
// ---------------------------------------------------------------------------

async fn http_connect(
    mut stream: TcpStream,
    proxy: &ProxyConfig,
    host: &str,
    port: u16,
) -> Result<TcpStream, AppError> {
    let target = format!("{host}:{port}");
    let mut req = format!(
        "CONNECT {target} HTTP/1.1\r\nHost: {target}\r\nProxy-Connection: Keep-Alive\r\nUser-Agent: Shelflux\r\n"
    );
    if !proxy.username.is_empty() {
        let token = base64_encode(format!("{}:{}", proxy.username, proxy.password).as_bytes());
        req.push_str(&format!("Proxy-Authorization: Basic {token}\r\n"));
    }
    req.push_str("\r\n");

    stream
        .write_all(req.as_bytes())
        .await
        .map_err(|e| AppError::Other(format!("代理请求发送失败: {e}")))?;
    stream.flush().await.ok();

    // 读取响应头（直到 \r\n\r\n）
    let mut head = Vec::with_capacity(256);
    let mut byte = [0u8; 1];
    loop {
        let n = stream
            .read(&mut byte)
            .await
            .map_err(|e| AppError::Other(format!("读取代理响应失败: {e}")))?;
        if n == 0 {
            return Err(AppError::Other("代理提前关闭了连接".into()));
        }
        head.push(byte[0]);
        if head.len() >= 4 && &head[head.len() - 4..] == b"\r\n\r\n" {
            break;
        }
        if head.len() > 8192 {
            return Err(AppError::Other("代理响应头过长".into()));
        }
    }

    let text = String::from_utf8_lossy(&head);
    let status_line = text.lines().next().unwrap_or("");
    let code = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse::<u16>().ok())
        .unwrap_or(0);
    if !(200..300).contains(&code) {
        return Err(AppError::Other(format!(
            "HTTP 代理拒绝 CONNECT：{}",
            status_line.trim()
        )));
    }
    Ok(stream)
}

// ---------------------------------------------------------------------------
// SOCKS5
// ---------------------------------------------------------------------------

async fn socks5_connect(
    mut stream: TcpStream,
    proxy: &ProxyConfig,
    host: &str,
    port: u16,
) -> Result<TcpStream, AppError> {
    let has_auth = !proxy.username.is_empty();

    // 1) 方法协商
    let greeting: Vec<u8> = if has_auth {
        vec![0x05, 0x02, 0x00, 0x02]
    } else {
        vec![0x05, 0x01, 0x00]
    };
    stream
        .write_all(&greeting)
        .await
        .map_err(|e| AppError::Other(format!("SOCKS5 握手失败: {e}")))?;

    let mut rep = [0u8; 2];
    stream
        .read_exact(&mut rep)
        .await
        .map_err(|e| AppError::Other(format!("SOCKS5 握手响应失败: {e}")))?;
    if rep[0] != 0x05 {
        return Err(AppError::Other("代理不是 SOCKS5".into()));
    }
    match rep[1] {
        0x00 => {}
        0x02 => {
            if !has_auth {
                return Err(AppError::Other("SOCKS5 代理要求认证但未配置用户名".into()));
            }
            socks5_auth(&mut stream, proxy).await?;
        }
        0xFF => return Err(AppError::Other("SOCKS5 代理拒绝了所有认证方式".into())),
        m => return Err(AppError::Other(format!("SOCKS5 不支持的认证方式: {m:#04x}"))),
    }

    // 2) CONNECT 请求（用域名让代理侧解析，避免本地 DNS 泄漏）
    let hb = host.as_bytes();
    if hb.len() > 255 {
        return Err(AppError::Other("主机名过长".into()));
    }
    let mut req = Vec::with_capacity(7 + hb.len());
    req.extend_from_slice(&[0x05, 0x01, 0x00, 0x03]);
    req.push(hb.len() as u8);
    req.extend_from_slice(hb);
    req.extend_from_slice(&port.to_be_bytes());
    stream
        .write_all(&req)
        .await
        .map_err(|e| AppError::Other(format!("SOCKS5 请求失败: {e}")))?;

    // 3) 响应
    let mut head = [0u8; 4];
    stream
        .read_exact(&mut head)
        .await
        .map_err(|e| AppError::Other(format!("SOCKS5 响应失败: {e}")))?;
    if head[1] != 0x00 {
        return Err(AppError::Other(format!(
            "SOCKS5 连接失败: {}",
            socks5_error_text(head[1])
        )));
    }
    // 跳过 BND.ADDR + BND.PORT
    match head[3] {
        0x01 => {
            let mut skip = [0u8; 6];
            let _ = stream.read_exact(&mut skip).await;
        }
        0x03 => {
            let mut len = [0u8; 1];
            let _ = stream.read_exact(&mut len).await;
            let mut skip = vec![0u8; len[0] as usize + 2];
            let _ = stream.read_exact(&mut skip).await;
        }
        0x04 => {
            let mut skip = [0u8; 18];
            let _ = stream.read_exact(&mut skip).await;
        }
        _ => return Err(AppError::Other("SOCKS5 响应地址类型非法".into())),
    }
    Ok(stream)
}

async fn socks5_auth(stream: &mut TcpStream, proxy: &ProxyConfig) -> Result<(), AppError> {
    let u = proxy.username.as_bytes();
    let p = proxy.password.as_bytes();
    if u.len() > 255 || p.len() > 255 {
        return Err(AppError::Other("SOCKS5 用户名/密码过长".into()));
    }
    let mut buf = Vec::with_capacity(3 + u.len() + p.len());
    buf.push(0x01); // 子协商版本
    buf.push(u.len() as u8);
    buf.extend_from_slice(u);
    buf.push(p.len() as u8);
    buf.extend_from_slice(p);
    stream
        .write_all(&buf)
        .await
        .map_err(|e| AppError::Other(format!("SOCKS5 认证失败: {e}")))?;

    let mut rep = [0u8; 2];
    stream
        .read_exact(&mut rep)
        .await
        .map_err(|e| AppError::Other(format!("SOCKS5 认证响应失败: {e}")))?;
    if rep[1] != 0x00 {
        return Err(AppError::Other("SOCKS5 用户名或密码错误".into()));
    }
    Ok(())
}

fn socks5_error_text(code: u8) -> &'static str {
    match code {
        0x01 => "一般性失败",
        0x02 => "规则不允许",
        0x03 => "网络不可达",
        0x04 => "主机不可达",
        0x05 => "连接被拒绝",
        0x06 => "TTL 超时",
        0x07 => "不支持的命令",
        0x08 => "不支持的地址类型",
        _ => "未知错误",
    }
}

// ---------------------------------------------------------------------------
// 极简 base64（仅用于 Proxy-Authorization，避免引入额外依赖）
// ---------------------------------------------------------------------------

fn base64_encode(input: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(T[(n >> 18 & 63) as usize] as char);
        out.push(T[(n >> 12 & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            T[(n >> 6 & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            T[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::base64_encode;

    #[test]
    fn base64_matches_reference() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"user:pass"), "dXNlcjpwYXNz");
    }
}
