//! The one-request web server that browser sign-ins (ChatGPT, OpenRouter) come back to.
//! It listens on this computer only, answers the callback, and stops.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio_util::sync::CancellationToken;

use crate::error::{AppError, AppResult};

pub struct Loopback {
    listeners: Vec<TcpListener>,
    port: u16,
}

/// Holds the browser's connection until the outcome is known, so its tab can say how it went.
pub struct Reply(TcpStream);

impl Reply {
    pub async fn page(mut self, ok: bool, message: &str) {
        let body = page(ok, message);
        let head = format!(
            "HTTP/1.1 {}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
            if ok { "200 OK" } else { "400 Bad Request" },
            body.len()
        );
        let _ = self.0.write_all(head.as_bytes()).await;
        let _ = self.0.write_all(body.as_bytes()).await;
        let _ = self.0.shutdown().await;
    }
}

impl Loopback {
    /// Listens on the first free port of `ports` (0 = any) on 127.0.0.1, and on ::1 too when
    /// it can, because browsers may resolve "localhost" to either.
    pub async fn bind(ports: &[u16]) -> AppResult<Self> {
        let mut last = None;
        for &port in ports {
            match TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], port))).await {
                Ok(v4) => {
                    let port = v4.local_addr()?.port();
                    let mut listeners = vec![v4];
                    if let Ok(v6) =
                        TcpListener::bind(SocketAddr::from(([0, 0, 0, 0, 0, 0, 0, 1], port))).await
                    {
                        listeners.push(v6);
                    }
                    return Ok(Self { listeners, port });
                }
                Err(e) => last = Some(e),
            }
        }
        Err(AppError::new(
            "no_port",
            format!(
                "Couldn't listen for the sign-in to come back: {}",
                last.map(|e| e.to_string()).unwrap_or_default()
            ),
        ))
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// Waits for a GET on `path` and returns its query. Other requests (favicon) get a 404.
    pub async fn wait(
        self,
        path: &str,
        timeout: Duration,
        cancel: CancellationToken,
    ) -> AppResult<(HashMap<String, String>, Reply)> {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let accepted = tokio::select! {
                _ = cancel.cancelled() => return Err(AppError::new("cancelled", "Sign-in cancelled.")),
                _ = tokio::time::sleep_until(deadline) => {
                    return Err(AppError::new("timeout", "The sign-in took too long. Try again."))
                }
                a = accept_any(&self.listeners) => a,
            };
            let Ok(stream) = accepted else { continue };
            match read_request(stream).await {
                Some((target, stream)) => {
                    let url = url::Url::parse(&format!("http://localhost{target}")).ok();
                    match url {
                        Some(u) if u.path() == path => {
                            let query = u
                                .query_pairs()
                                .map(|(k, v)| (k.into_owned(), v.into_owned()))
                                .collect();
                            return Ok((query, Reply(stream)));
                        }
                        _ => not_found(stream).await,
                    }
                }
                None => continue,
            }
        }
    }
}

async fn accept_any(listeners: &[TcpListener]) -> std::io::Result<TcpStream> {
    let futs = listeners
        .iter()
        .map(|l| Box::pin(async move { l.accept().await.map(|(s, _)| s) }));
    let (res, _, _) = futures_util::future::select_all(futs).await;
    res
}

/// Reads the request line and headers; returns the request target.
async fn read_request(stream: TcpStream) -> Option<(String, TcpStream)> {
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    tokio::time::timeout(Duration::from_secs(10), reader.read_line(&mut line))
        .await
        .ok()?
        .ok()?;
    loop {
        let mut h = String::new();
        let n = tokio::time::timeout(Duration::from_secs(10), reader.read_line(&mut h))
            .await
            .ok()?
            .ok()?;
        if n == 0 || h == "\r\n" || h == "\n" {
            break;
        }
    }
    let mut parts = line.split(' ');
    let method = parts.next()?;
    let target = parts.next()?.to_string();
    if method != "GET" {
        return None;
    }
    Some((target, reader.into_inner()))
}

async fn not_found(mut stream: TcpStream) {
    let _ = stream
        .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
        .await;
}

fn page(ok: bool, message: &str) -> String {
    let color = if ok { "#1f7a4d" } else { "#c0392b" };
    let escaped = message
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");
    format!(
        "<!doctype html><meta charset=utf-8><title>Writey</title>\
         <body style=\"font:17px system-ui;display:grid;place-items:center;height:100vh;margin:0;background:#f2efe7\">\
         <div style=\"max-width:28em;text-align:center\"><p style=\"font:600 28px Georgia,serif;margin:0 0 .4em;color:#1d1c19\">Writey</p>\
         <p style=\"color:{color}\">{escaped}</p></div></body>"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn returns_the_callback_query() {
        let lb = Loopback::bind(&[0]).await.unwrap();
        let port = lb.port();
        let cancel = CancellationToken::new();
        let waiting = tokio::spawn(lb.wait("/cb", Duration::from_secs(5), cancel));
        let client = reqwest::Client::new();
        let r = client
            .get(format!("http://127.0.0.1:{port}/favicon.ico"))
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 404);
        let fetch = tokio::spawn(async move {
            client
                .get(format!("http://127.0.0.1:{port}/cb?code=abc&state=x%20y"))
                .send()
                .await
        });
        let (q, reply) = waiting.await.unwrap().unwrap();
        assert_eq!(q["code"], "abc");
        assert_eq!(q["state"], "x y");
        reply.page(true, "Signed in <ok>").await;
        let body = fetch.await.unwrap().unwrap().text().await.unwrap();
        assert!(body.contains("Signed in &lt;ok&gt;"));
    }

    #[tokio::test]
    async fn can_be_cancelled() {
        let lb = Loopback::bind(&[0]).await.unwrap();
        let cancel = CancellationToken::new();
        cancel.cancel();
        let err = lb
            .wait("/cb", Duration::from_secs(5), cancel)
            .await
            .err()
            .unwrap();
        assert_eq!(err.code, "cancelled");
    }
}
