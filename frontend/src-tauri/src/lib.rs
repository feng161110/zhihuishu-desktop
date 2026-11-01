use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{Manager, RunEvent};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const BACKEND_ADDR: &str = "127.0.0.1:8765";
const BACKEND_PORT: &str = "8765";

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

struct BackendProcess(Mutex<Option<Child>>);

fn backend_is_up() -> bool {
    let addr = match BACKEND_ADDR.parse() {
        Ok(addr) => addr,
        Err(_) => return false,
    };
    TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok()
}

/// 直接向后端发一个简短的 HTTP 请求（不引入 reqwest，退出路径要够轻）。
fn http_send(method: &str, path: &str) -> Option<String> {
    let addr = BACKEND_ADDR.parse::<std::net::SocketAddr>().ok()?;
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(500)).ok()?;
    let _ = stream.set_read_timeout(Some(Duration::from_millis(2000)));
    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: {BACKEND_ADDR}\r\nContent-Type: application/json\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(request.as_bytes()).ok()?;
    let mut buffer = [0u8; 128];
    let read = stream.read(&mut buffer).ok()?;
    if read == 0 {
        return None;
    }
    Some(String::from_utf8_lossy(&buffer[..read]).into_owned())
}

fn http_ok(method: &str, path: &str) -> bool {
    matches!(http_send(method, path), Some(response) if response.contains(" 200"))
}

/// 关窗时让后端结束学习任务，但保留队列——下次打开会自动续播。
fn stop_engine() {
    let _ = http_send("POST", "/api/engine/stop?keep_session=1");
}

fn wait_backend_ready(timeout: Duration) -> bool {
    let started = Instant::now();
    while started.elapsed() < timeout {
        if http_ok("GET", "/api/health") {
            return true;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    false
}

fn backend_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    // 环境变量优先：既支持指向源码目录，也支持只指向 bin/zhs-backend
    if let Ok(dir) = std::env::var("ZHS_BACKEND_DIR") {
        let path = PathBuf::from(dir);
        if path.join("main.py").is_file() || bundled_backend(&path).is_some() {
            return Some(path);
        }
    }

    // 开发态始终跑源码（打包后这里指向构建机路径，通常已不存在）
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../backend");
    if dev.join("main.py").is_file() {
        return Some(dev.canonicalize().unwrap_or(dev));
    }

    // 安装目录：新布局只有 bin/zhs-backend，旧布局可能还带源码
    if let Ok(resource) = app.path().resource_dir() {
        for candidate in [resource.join("backend"), resource.join("_up_").join("backend")] {
            if candidate.join("main.py").is_file() || bundled_backend(&candidate).is_some() {
                return Some(candidate);
            }
        }
    }

    None
}

/// 结束后端进程树。Windows 上用 taskkill /T，避免 uvicorn 的派生进程残留占端口。
fn stop_backend(mut child: Child) {
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// 结束指定进程及其子树。
#[cfg(windows)]
fn kill_tree(pid: u32) {
    let _ = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .status();
}

/// 当前监听后端端口的进程 PID（只统计 LISTENING，且排除自己）。
#[cfg(windows)]
fn port_pids() -> Vec<u32> {
    let output = match Command::new("netstat")
        .args(["-ano", "-p", "TCP"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
    {
        Ok(output) => output,
        Err(_) => return Vec::new(),
    };
    let text = String::from_utf8_lossy(&output.stdout);
    let suffix = format!(":{BACKEND_PORT}");
    let mut pids = Vec::new();
    for line in text.lines() {
        let cols: Vec<&str> = line.split_whitespace().collect();
        // Proto / 本地地址 / 外部地址 / 状态 / PID
        if cols.len() < 5 || cols[3] != "LISTENING" || !cols[1].ends_with(&suffix) {
            continue;
        }
        if let Ok(pid) = cols[4].parse::<u32>() {
            if pid != std::process::id() && !pids.contains(&pid) {
                pids.push(pid);
            }
        }
    }
    pids
}

/// 按端口清理后端：进程树被系统回收、只留下监听者时也能命中。
#[cfg(windows)]
fn kill_port_listeners() -> usize {
    let pids = port_pids();
    for pid in &pids {
        kill_tree(*pid);
    }
    pids.len()
}

#[cfg(not(windows))]
fn kill_port_listeners() -> usize {
    0
}

/// 按镜像名清理后端。仅打包态有效（进程名固定为 zhs-backend.exe）；
/// 开发态后端是 python，不能按名杀，交给端口清理。
#[cfg(windows)]
fn kill_named_backend() {
    let _ = Command::new("taskkill")
        .args(["/IM", "zhs-backend.exe", "/T", "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .status();
}

#[cfg(not(windows))]
fn kill_named_backend() {}

/// 启动前清理上一次运行残留的后端进程。
///
/// 上次被强杀（任务管理器 / 崩溃）时来不及走 RunEvent::Exit，
/// 残留进程会一直占着 8765，并带着旧的课程与播放上下文——必须先清掉再启动。
/// 是否“自家后端”用 /api/health 判定，避免误杀占着该端口的无关进程。
fn kill_stale_backend() {
    if http_ok("GET", "/api/health") {
        kill_named_backend();
        let killed = kill_port_listeners();
        if killed > 0 {
            eprintln!("已清理 {killed} 个残留的后端进程");
        }
    } else if backend_is_up() {
        // 端口有人在听但不像本项目后端（可能是卡死的旧实例）：只按镜像名精确清理
        kill_named_backend();
    }
    // 等端口真正释放，否则紧接着的 bind 会失败
    for _ in 0..20 {
        if !backend_is_up() {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// 随安装包分发的独立后端（PyInstaller 打包），存在时优先使用，用户机器无需 Python 环境。
fn bundled_backend(dir: &std::path::Path) -> Option<PathBuf> {
    let name = if cfg!(windows) { "zhs-backend.exe" } else { "zhs-backend" };
    let exe = dir.join("bin").join("zhs-backend").join(name);
    if exe.is_file() {
        Some(exe)
    } else {
        None
    }
}

fn spawn_backend(app: &tauri::AppHandle) -> Option<Child> {
    // 启动前先清掉上一次运行残留的后端（强杀时走不到 RunEvent::Exit）
    kill_stale_backend();
    if backend_is_up() {
        // 清理失败（权限不足，或端口被别的程序占着）：退回复用，至少保证界面可用
        eprintln!("{BACKEND_ADDR} 清理后仍被占用，直接复用现有服务");
        return None;
    }

    let dir = backend_dir(app)?;

    // 开发态（tauri dev）始终跑源码，避免用到过期的打包 exe
    let bundled = if tauri::is_dev() { None } else { bundled_backend(&dir) };

    let mut command = if let Some(exe) = bundled {
        // 内置后端 exe：自己会拉起 uvicorn，不需要系统 Python
        eprintln!("启动内置后端：{}", exe.display());
        let workdir = exe.parent().map(PathBuf::from).unwrap_or_else(|| dir.clone());
        let mut cmd = Command::new(&exe);
        cmd.current_dir(workdir);
        cmd
    } else {
        // 开发态回退：用系统 Python 跑 uvicorn
        let python = std::env::var("ZHS_PYTHON").unwrap_or_else(|_| "python".to_string());
        let mut cmd = Command::new(python);
        cmd.args([
            "-X",
            "utf8",
            "-m",
            "uvicorn",
            "main:app",
            "--host",
            "127.0.0.1",
            "--port",
            BACKEND_PORT,
            "--log-level",
            "warning",
            "--no-access-log",
            "--timeout-graceful-shutdown",
            "2",
        ])
        .current_dir(&dir);
        cmd
    };

    command
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUNBUFFERED", "1")
        // 让后端看护父进程：前端被强杀 / 崩溃时也能立刻停止学习任务
        .env("ZHS_PARENT_PID", std::process::id().to_string());

    #[cfg(windows)]
    {
        command.creation_flags(CREATE_NO_WINDOW);
    }

    match command.spawn() {
        Ok(child) => {
            // 等后端真正可用再返回，避免前端启动后还要盲等几十秒
            if !wait_backend_ready(Duration::from_secs(15)) {
                eprintln!("后端启动超时，{BACKEND_ADDR} 尚未就绪");
            }
            Some(child)
        }
        Err(error) => {
            eprintln!("无法启动 Python 后端：{error}");
            None
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            // 先占位，后端在后台线程拉起：启动画面不必等 PyInstaller 把依赖加载完
            app.manage(BackendProcess(Mutex::new(None)));

            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let child = spawn_backend(&handle);
                if let Some(state) = handle.try_state::<BackendProcess>() {
                    if let Ok(mut guard) = state.0.lock() {
                        *guard = child;
                    }
                }
                // 上次关窗若没来得及结束任务（例如复用了一个残留后端），
                // 这里先把残留任务停掉；前端连上后会按保留的队列自动续播。
                stop_engine();
            });

            // 窗口在配置里默认隐藏（避免加载前的黑屏），由前端首屏渲染后 show()。
            // 兜底：万一前端脚本没跑起来，也不能让窗口一直不可见。
            let reveal = app.handle().clone();
            std::thread::spawn(move || {
                // 前端正常会在首屏渲染后自己 show()；这里只在前端脚本异常时兜底，
                // 因此先留出足够时间，避免抢在前端之前把未渲染的窗口亮出来
                std::thread::sleep(Duration::from_secs(5));
                if let Some(window) = reveal.get_webview_window("main") {
                    if !window.is_visible().unwrap_or(true) {
                        let _ = window.show();
                    }
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("构建 Tauri 应用失败");

    app.run(|handle, event| match event {
        // 关窗第一时间通知后端结束任务（保留队列，下次打开续播）
        RunEvent::ExitRequested { .. } => stop_engine(),
        RunEvent::Exit => {
            stop_engine();
            // 给后端一点时间把任务停下来并落盘会话，再结束进程树
            std::thread::sleep(Duration::from_millis(400));
            if let Some(state) = handle.try_state::<BackendProcess>() {
                if let Ok(mut guard) = state.0.lock() {
                    if let Some(child) = guard.take() {
                        stop_backend(child);
                    }
                }
            }
            // 兜底：child 为空（启动时复用了已有服务）或已被系统回收时，
            // 再清一次，保证退出后不留下任何后端进程。
            // 端口清理仍以 /api/health 判定归属，避免连累占着 8765 的其他程序。
            kill_named_backend();
            if http_ok("GET", "/api/health") {
                kill_port_listeners();
            }
        }
        _ => {}
    });
}
