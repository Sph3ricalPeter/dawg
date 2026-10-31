//! The local pipe between `dawg-cli mcp` and the open dawg window: a named
//! pipe on Windows (a namespaced local socket elsewhere), per user, never on
//! the network. One request per connection: a line of JSON naming a tool
//! and its arguments, answered by a line holding the tool's MCP result.

use std::io::{self, BufRead, BufReader, Write};
use std::sync::Arc;

use interprocess::local_socket::{prelude::*, GenericNamespaced, ListenerOptions, Stream};
use serde_json::{json, Value};

/// App ids whose windows an agent can attach to, release first.
pub const APP_IDS: &[&str] = &["com.sph3ricalpeter.dawg", "com.sph3ricalpeter.dawg.dev"];

/// The pipe an app with `app_id` listens on, for this user.
pub fn name(app_id: &str) -> String {
    let user = std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .unwrap_or_default();
    let user: String = user
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        .collect();
    format!("{app_id}.mcp.{user}")
}

/// Runs a tool in the open app, if there is one: `None` when no dawg window
/// is listening. `DAWG_PIPE` names the pipe instead of the app ids.
pub fn call_app(tool: &str, args: &Value) -> Option<Result<Vec<Value>, String>> {
    let names: Vec<String> = match std::env::var("DAWG_PIPE") {
        Ok(n) => vec![n],
        Err(_) => APP_IDS.iter().map(|id| name(id)).collect(),
    };
    names.iter().find_map(|n| call_on(n, tool, args))
}

fn call_on(pipe: &str, tool: &str, args: &Value) -> Option<Result<Vec<Value>, String>> {
    let ns = pipe.to_ns_name::<GenericNamespaced>().ok()?;
    let conn = Stream::connect(ns).ok()?;
    Some(exchange(conn, tool, args).unwrap_or_else(|e| Err(format!("lost the dawg window: {e}"))))
}

fn exchange(conn: Stream, tool: &str, args: &Value) -> io::Result<Result<Vec<Value>, String>> {
    let mut conn = BufReader::new(conn);
    let req = json!({ "name": tool, "arguments": args });
    conn.get_mut().write_all(format!("{req}\n").as_bytes())?;
    let mut line = String::new();
    conn.read_line(&mut line)?;
    let v: Value = serde_json::from_str(&line).map_err(io::Error::other)?;
    let content = v
        .get("content")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if v.get("isError").and_then(Value::as_bool) == Some(true) {
        let msg = content
            .first()
            .and_then(|c| c.get("text"))
            .and_then(Value::as_str)
            .unwrap_or("the app refused")
            .to_string();
        return Ok(Err(msg));
    }
    Ok(Ok(content))
}

/// Answers tool calls on `pipe` with `handler` until the process ends, one
/// thread per connection. Fails if the pipe can't be made (another window of
/// the same app already has it).
pub fn serve<F>(pipe: &str, handler: F) -> io::Result<()>
where
    F: Fn(&str, &Value) -> Result<Vec<Value>, String> + Send + Sync + 'static,
{
    let ns = pipe.to_ns_name::<GenericNamespaced>()?;
    let listener = ListenerOptions::new().name(ns).create_sync()?;
    let handler = Arc::new(handler);
    for conn in listener.incoming().filter_map(Result::ok) {
        let handler = handler.clone();
        std::thread::spawn(move || {
            let mut conn = BufReader::new(conn);
            let mut line = String::new();
            if conn.read_line(&mut line).is_err() {
                return;
            }
            let r = match serde_json::from_str::<Value>(&line) {
                Ok(req) => {
                    let tool = req.get("name").and_then(Value::as_str).unwrap_or("");
                    let args = req.get("arguments").cloned().unwrap_or(json!({}));
                    handler(tool, &args)
                }
                Err(e) => Err(e.to_string()),
            };
            let reply = crate::mcp::result(r);
            let _ = conn.get_mut().write_all(format!("{reply}\n").as_bytes());
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_call_reaches_the_app_and_comes_back() {
        let pipe = format!("dawg-test-{}.sock", std::process::id());
        let p = pipe.clone();
        std::thread::spawn(move || {
            serve(&p, |tool, args| match tool {
                "echo" => Ok(vec![args.clone()]),
                _ => Err(format!("no tool {tool}")),
            })
        });
        let mut r = None;
        for _ in 0..100 {
            r = call_on(&pipe, "echo", &json!({ "a": 1 }));
            if r.is_some() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert_eq!(r, Some(Ok(vec![json!({ "a": 1 })])));
        assert_eq!(
            call_on(&pipe, "nope", &json!({})),
            Some(Err("no tool nope".into()))
        );
        assert_eq!(call_on("dawg-test-nobody.sock", "echo", &json!({})), None);
    }
}
