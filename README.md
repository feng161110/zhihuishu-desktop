# 智慧树学习助手（ZhihuishuDesk）

Windows 桌面端工具，用本地程序管理自己在智慧树平台上的学习进度：同步课程台账、排队播放视频、辅助完成人机验证。

本软件不是智慧树官方产品，与平台运营方、任何学校或教育机构没有隶属、合作或授权关系。使用前请完整阅读 [使用说明与免责声明](./使用说明与免责声明.md)。

## 功能

- **课程同步**：登录后读取名下课程、章节目录、每个视频的时长与平台侧学习进度，形成本机台账。
- **排队播放**：按勾选的顺序逐条播放，支持倍速、暂停 / 继续 / 停止、单集播放、自动续播。
- **进度对账**：每秒推进一次进度并定期回传，可按平台判定或「严格 100%」两种口径收手。
- **弹窗题处理**：播放中到点触发的小题自动作答，失败按退避重试，收尾补齐漏答。
- **人机验证辅助**：
  - 登录滑块：本地识别缺口，失败立即转手动拖动。
  - 学习页点选（易盾空间推理）：自动识别点位，可随时接手手动点选。
  - 识别全部在本机完成（OpenCV + ddddocr + onnxruntime），不联网、不上传图片。
- **本地优先**：账号、Cookie、设置、队列都只写本机数据目录；日志只在本地界面展示，不上传任何服务器。

## 下载与安装

1. 打开 [Releases](https://github.com/feng161110/zhihuishu-desktop/releases/latest)，下载 `ZhihuishuDesk_x.y.z_x64-setup.exe`。
2. 双击安装（默认安装到当前用户目录，无需管理员权限）。
3. 从开始菜单或桌面快捷方式启动，首次启动会拉起内置后端，通常几秒完成。

系统要求：Windows 10 / 11（64 位）。卸载在「Windows 设置 → 应用」中完成，不会自动删除本地数据目录。

## 浏览器用户脚本（可选）

仓库另附一个只作用于网页版的用户脚本 [`userscript/zhihuishu-helper.user.js`](./userscript/zhihuishu-helper.user.js)，与桌面端相互独立，不需要安装本应用。

| 页面 | 行为 |
| --- | --- |
| `onlineexamh5new.zhihuishu.com/stuExamWeb.html` | 共享课作业：抓包解析题目 |
| `*.hiexam.zhihuishu.com/atHomeworkExam/` | 翻转课作业：遍历抓取题目 |
| `chat.deepseek.com` | 后台工作页：接收题目、回传答案 JSON |

工作方式：作业页把题目与提示词写入脚本存储，脚本自动开一个 DeepSeek 后台标签页答题，解析出答案后回传并自动填写；后台页空闲一段时间会自动关闭。

**安装**

1. 先安装用户脚本管理器：Tampermonkey 或 脚本猫（ScriptCat）。
2. 打开脚本地址（任选其一）：
   - jsDelivr（国内更快）：`https://cdn.jsdelivr.net/gh/feng161110/zhihuishu-desktop@main/userscript/zhihuishu-helper.user.js`
   - GitHub：`https://github.com/feng161110/zhihuishu-desktop/blob/main/userscript/zhihuishu-helper.user.js?raw=true`
3. 管理器识别到 `==UserScript==` 头后点击「安装」。

**自动更新**

脚本头里的 `@updateURL` / `@downloadURL` 指向 jsDelivr 的 `main` 分支，管理器会按 `@version` 周期性检查更新。本仓库改动版本号并推送后，已安装的脚本会提示升级。jsDelivr 对分支地址有缓存（通常几小时），需要立刻生效时可访问 `https://purge.jsdelivr.net/gh/feng161110/zhihuishu-desktop@main/userscript/zhihuishu-helper.user.js` 刷新缓存。

脚本依赖浏览器里已登录的 DeepSeek 账号，答题质量取决于模型输出，**不保证正确率**；用 AI 代做作业存在学术诚信与平台规则风险，请自行判断并承担后果。

## 界面与设置

- 底部控制条：倍速（1.0–3.0，播放中锁定）、严格 100%、自动识别验证码、开始 / 暂停 / 继续 / 停止。
- 严格 100%：不勾选时完全按平台判定；勾选后跳过与收手都以「实际看满时长」为准。
- 关闭窗口只停止播放并保留队列，下次启动自动续播；点「停止」才会清空队列。
- 右上角「运行日志」可查看实时日志，`Esc` 收起。

详细功能说明、常见问题与合规提醒见 [使用说明与免责声明](./使用说明与免责声明.md)。

## 本地数据与隐私

默认数据目录：`%APPDATA%\com.zhihuishu.desk`

| 文件 | 内容 |
| --- | --- |
| `settings.json` | 倍速、严格 100%、自动识别、记住密码开关、重试次数、接口流水开关 |
| `credentials.json` | 账号、Cookie / 会话信息；勾选「记住密码」时会一并保存密码 |
| `engine_session.json` | 上次播放的课程与队列（用于自动续播） |

上述文件是**明文 JSON**，未加密。请勿分享、同步到网盘或提交到代码仓库；公用电脑建议取消「记住密码」。

程序不会把运行日志或错误信息上传到任何服务器。可用环境变量：

| 变量 | 作用 |
| --- | --- |
| `ZHS_PORT` | 本地后端端口，默认 `8765` |
| `ZHS_DATA_DIR` | 指定数据目录（便于便携使用） |
| `ZHS_BACKEND_DIR` | 指定后端目录（开发调试用） |
| `ZHS_PYTHON` | 指定 Python 解释器（回退源码模式时使用） |

## 更新

- 启动后自动静默检查一次，发现新版时按钮变为「更新到 vX.Y.Z」，点击后下载、校验签名、覆盖安装并重启。
- 更新源：`https://github.com/feng161110/zhihuishu-desktop/releases/latest/download/latest.json`
- 安装包带 Minisign 签名校验，签名不匹配会被拒绝安装。

## 项目结构

```
.
├─ backend/                 Python 后端（FastAPI，仅监听 127.0.0.1:8765）
│  ├─ main.py               路由、生命周期、父进程看护
│  ├─ core/                 auth / client / engine / bus / config / state / study_captcha
│  ├─ vendor/               captcha（滑块、易盾加密、空间推理）、encrypt（AES-CBC）
│  └─ requirements.txt
├─ frontend/                React 18 + Vite 5 界面
│  ├─ src/                  App、hooks/useWorkspace（数据层）、components
│  └─ src-tauri/            Tauri 2 外壳（Rust）：拉起与清理后端、窗口
├─ scripts/                 build_backend.py（PyInstaller）、gen_icons.py
├─ userscript/              zhihuishu-helper.user.js（浏览器用户脚本）
└─ 使用说明与免责声明.md
```

后端以 SSE（`/api/events`）向界面推送引擎状态、进度、日志与验证码事件；界面断线时按 4 秒轮询兜底。

## 从源码运行

需要 Python 3.11+、Node.js 18+、Rust 1.77+。

```bat
:: 后端
cd backend
pip install -r requirements.txt
python -X utf8 main.py                       :: 或 uvicorn main:app --host 127.0.0.1 --port 8765

:: 前端
cd frontend
npm install
npm run dev        :: 浏览器预览（无自动更新与窗口控制）
npm run desktop    :: Tauri 开发模式
```

## 打包

```bat
:: 1) 后端打成独立 exe（PyInstaller onedir -> backend/bin/zhs-backend/）
python scripts/build_backend.py

:: 2) 前端 + NSIS 安装包（产物在 frontend/src-tauri/target/release/bundle/nsis/）
cd frontend
npm run bundle
```

updater 签名需要私钥，构建前设置环境变量：

```bat
set TAURI_SIGNING_PRIVATE_KEY=<私钥内容>
set TAURI_SIGNING_PRIVATE_KEY_PASSWORD=<私钥密码>
```

公钥写在 `frontend/src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey`，与私钥必须配对。发版时把安装包、`.sig` 与 `latest.json` 一起上传到 GitHub Releases。

## 免责声明

1. 本软件为个人学习与技术研究用途的工具，不提供、存储、分发、销售任何课程视频、课件、题库或账号。
2. 使用自动化方式辅助观看课程**可能违反平台用户协议或学校管理规定**，可能导致限流、警告、学习记录或成绩作废、账号封禁等后果，风险与后果由使用者自行承担。
3. 严禁用于代刷、代看、批量挂机、多账号刷课、商业代刷、破解付费内容或攻击平台服务。
4. 本软件按「现状」提供，不附带任何明示或默示担保；因使用或无法使用本软件造成的损失，作者与贡献者不承担任何责任。

完整条款见 [使用说明与免责声明](./使用说明与免责声明.md) 第二部分。**如不同意，请立即停止使用并卸载。**
