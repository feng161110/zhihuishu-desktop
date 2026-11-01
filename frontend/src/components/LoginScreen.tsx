import { useEffect, useState } from "react";
import { api } from "../api";
import type { CaptchaPayload } from "../types";
import CaptchaModal from "./CaptchaModal";
import { IconEye, IconEyeOff, IconLock, IconShield, IconUser } from "./Icons";

interface Props {
  onAuthed: () => Promise<void> | void;
  dataDir?: string;
}

export default function LoginScreen({ onAuthed, dataDir }: Props) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(false);
  const [autoSolve, setAutoSolve] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [captcha, setCaptcha] = useState<CaptchaPayload | null>(null);
  const [notice, setNotice] = useState("");
  const [savedHint, setSavedHint] = useState(false);

  useEffect(() => {
    const storedRemember = localStorage.getItem("zhs.remember");
    setUsername(localStorage.getItem("zhs.username") || "");
    // 默认勾选“记住密码”，除非用户之前主动取消过
    setRemember(storedRemember === null ? true : storedRemember === "1");
    // 读取上一次成功登录的账号信息并填充；密码只在用户允许记住时填充
    let alive = true;
    api
      .savedCredentials()
      .then((saved) => {
        if (!alive) return;
        if (saved.username) setUsername(saved.username);
        if (saved.remember && saved.password) {
          setPassword(saved.password);
          setRemember(true);
        }
        if (saved.username) setSavedHint(true);
      })
      .catch(() => {
        /* 后端未就绪时忽略，按空表单展示 */
      });
    return () => {
      alive = false;
    };
  }, []);

  const toggleRemember = (next: boolean) => {
    setRemember(next);
    localStorage.setItem("zhs.remember", next ? "1" : "0");
    // 立即同步到后端：取消勾选会顺手清掉已保存的密码
    void api.saveSettings({ remember_password: next }).catch(() => {
      /* 忽略网络错误，登录时仍会再次同步 */
    });
  };

  const submit = async () => {
    if (loading) return;
    if (!username.trim()) {
      setError("请输入智慧树账号");
      return;
    }
    if (!password) {
      setError("请输入密码");
      return;
    }
    setError("");
    setLoading(true);
    localStorage.setItem("zhs.username", username.trim());
    localStorage.setItem("zhs.remember", remember ? "1" : "0");
    try {
      const result = await api.login({
        username: username.trim(),
        password,
        auto_solve: autoSolve,
        remember,
      });
      if (result.status === "ok") {
        await onAuthed();
        return;
      }
      if (result.status === "captcha" && result.captcha) {
        setNotice(result.message || "");
        setCaptcha(result.captcha);
      } else {
        setError(result.message || "登录失败，请重试");
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="gate">
      <div className="gate-inner">
        <section className="gate-brand">
          <img className="brand-frog" src="/frog.png" alt="" />
          <h1>
            把网课时间
            <br />
            还给自己的事
          </h1>
          <p>
            登录智慧树账号，课程、章节与学习进度会同步到本机台账。密码与 Cookie 只写入本地数据目录，
            不上传任何第三方服务。
          </p>
          <ul>
            <li>自动识别滑块，失败时手动拖动补上</li>
            <li>每秒回传学习进度，进度条实时走动</li>
            <li>整章排队播放，可随时暂停、继续或停止</li>
          </ul>
        </section>

        <form
          className="gate-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <h2>登录</h2>

          {savedHint && (
            <p className="gate-hint">
              <IconShield size={12} />
              已填入上次成功登录的账号，确认后点击登录
            </p>
          )}

          <label className="field">
            <span>账号</span>
            <span className="field-input">
              <IconUser size={16} />
              <input
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder="手机号或学号"
                autoFocus
                spellCheck={false}
                autoComplete="username"
              />
            </span>
          </label>

          <label className="field">
            <span>密码</span>
            <span className="field-input">
              <IconLock size={16} />
              <input
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="智慧树登录密码"
                autoComplete="current-password"
              />
              <button
                type="button"
                className="field-toggle"
                onClick={(event) => {
                  // 阻止 label 把点击转发给输入框；任何状态下都可点击切换
                  event.preventDefault();
                  event.stopPropagation();
                  setShowPassword((prev) => !prev);
                }}
                aria-label={showPassword ? "隐藏密码" : "显示密码"}
                title={showPassword ? "点击隐藏密码" : "点击显示密码"}
              >
                {showPassword ? <IconEyeOff size={15} /> : <IconEye size={15} />}
              </button>
            </span>
          </label>

          <div className="gate-options">
            <label className="check-line">
              <input type="checkbox" checked={remember} onChange={(e) => toggleRemember(e.target.checked)} />
              <span>记住密码</span>
            </label>
            <label className="check-line">
              <input type="checkbox" checked={autoSolve} onChange={(e) => setAutoSolve(e.target.checked)} />
              <span>自动过滑块</span>
            </label>
          </div>

          {error && <p className="form-error">{error}</p>}

          <button className="btn btn-primary block" type="submit" disabled={loading}>
            {loading ? <span className="spinner small" /> : null}
            {loading ? (autoSolve ? "正在自动验证并登录" : "正在登录") : "登录并同步课程"}
          </button>

          <p className="gate-note">
            <IconShield size={13} />
            凭据保存在本机
            {dataDir && <code title={dataDir}>{dataDir}</code>}
          </p>
        </form>
      </div>

      {captcha && (
        <CaptchaModal
          payload={captcha}
          notice={notice}
          onCancel={() => setCaptcha(null)}
          onSolved={async () => {
            setCaptcha(null);
            await onAuthed();
          }}
        />
      )}
    </div>
  );
}
