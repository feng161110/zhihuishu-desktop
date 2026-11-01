import { useCallback, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { check, type Update } from "@tauri-apps/plugin-updater";

export type UpdateStatus = "idle" | "checking" | "available" | "downloading" | "installing";

type Notify = (text: string, level?: "info" | "success" | "error") => void;

/**
 * 桌面端更新：请求 latest.json → 下载签名包 → 交给 NSIS 安装器覆盖安装并自动重启。
 * 浏览器里（vite dev）直接跳过，不影响网页预览。
 */
export function useUpdater(notify: Notify) {
  const [status, setStatus] = useState<UpdateStatus>("idle");
  const [version, setVersion] = useState("");
  const [progress, setProgress] = useState(0);

  const updateRef = useRef<Update | null>(null);
  const busyRef = useRef(false);

  const checkForUpdate = useCallback(
    async (silent = false) => {
      if (busyRef.current) return;
      if (!isTauri()) {
        if (!silent) notify("浏览器预览模式不支持自动更新，请在安装版中使用", "info");
        return;
      }
      busyRef.current = true;
      setStatus("checking");
      try {
        const update = await check();
        if (!update) {
          if (!silent) notify("当前已是最新版本", "success");
          setStatus("idle");
          return;
        }
        updateRef.current = update;
        setVersion(update.version);
        setStatus("available");
        notify(`发现新版本 v${update.version}，可在右上角更新`, "info");
      } catch (error) {
        setStatus("idle");
        if (!silent) notify(`检查更新失败：${(error as Error).message}`, "error");
      } finally {
        busyRef.current = false;
      }
    },
    [notify],
  );

  const installUpdate = useCallback(async () => {
    const update = updateRef.current;
    if (!update || busyRef.current) return;
    busyRef.current = true;
    setStatus("downloading");
    setProgress(0);

    let total = 0;
    let received = 0;
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? 0;
        } else if (event.event === "Progress") {
          received += event.data.chunkLength;
          if (total > 0) setProgress(Math.min(99, Math.round((received / total) * 100)));
        } else {
          setProgress(100);
        }
      });
      // Windows 下安装器会结束当前进程并在安装完成后自动重启应用
      updateRef.current = null;
      setStatus("installing");
      notify("更新已下载，安装完成后会自动启动新版本", "success");
    } catch (error) {
      updateRef.current = null;
      setStatus("idle");
      notify(`更新失败：${(error as Error).message}`, "error");
    } finally {
      busyRef.current = false;
    }
  }, [notify]);

  return { status, version, progress, checkForUpdate, installUpdate };
}
