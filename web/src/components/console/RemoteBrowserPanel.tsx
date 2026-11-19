import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  CornerDownLeft,
  Globe,
  Hand,
  Keyboard,
  Lock,
  Maximize2,
  Minimize2,
  MousePointerClick,
  Plus,
  RefreshCw,
  RotateCw,
  Send,
  X,
} from "lucide-react";
import {
  type KeyboardEvent,
  type PointerEvent,
  type WheelEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { api, type BrowserStatus } from "@/api";
import { ConsoleInput } from "@/components/console/ConsolePrimitives";
import {
  Alert,
  AlertAction,
  AlertContent,
  AlertDescription,
  AlertIcon,
  AlertTitle,
} from "@/components/motion/alert";
import { AnimatedBadge } from "@/components/motion/animated-badge";
import { Button } from "@/components/motion/button";
import { Switch } from "@/components/motion/switch";

export interface RemoteBrowserPanelProps {
  onToast: (input: { title: string; description?: string; status?: "info" | "success" | "error" }) => void;
  onPendingTakeoverChange: (pending: boolean) => void;
  onGoToChatAndResume: () => void;
}

const DEFAULT_STATUS: BrowserStatus = {
  open: false,
  busy: false,
  pendingTakeover: false,
  takeoverReason: null,
  displayMode: "closed",
  xvfbDisplay: null,
  proxyKey: null,
  url: null,
  title: null,
  viewport: { width: 1280, height: 800 },
  tabs: [],
};

const SPECIAL_KEY_SET = new Set([
  "Enter",
  "Backspace",
  "Tab",
  "Escape",
  "Delete",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
]);

function mapBrowserKey(e: KeyboardEvent<HTMLElement>): { type: "press" | "insert"; value: string } | null {
  if (e.metaKey || e.ctrlKey || e.altKey) {
    const mods: string[] = [];
    if (e.ctrlKey) mods.push("Control");
    if (e.metaKey) mods.push("Meta");
    if (e.altKey) mods.push("Alt");
    if (e.shiftKey) mods.push("Shift");
    if (!["Control", "Meta", "Alt", "Shift"].includes(e.key)) {
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      return { type: "press", value: `${mods.join("+")}+${k}` };
    }
    return null;
  }
  if (SPECIAL_KEY_SET.has(e.key)) {
    return { type: "press", value: e.key };
  }
  if (e.key === " ") {
    return { type: "press", value: "Space" };
  }
  if (e.key.length === 1) {
    return { type: "insert", value: e.key };
  }
  return null;
}

export function RemoteBrowserPanel({
  onToast,
  onPendingTakeoverChange,
  onGoToChatAndResume,
}: RemoteBrowserPanelProps) {
  const [status, setStatus] = useState<BrowserStatus>(DEFAULT_STATUS);
  const [streamError, setStreamError] = useState<string>("");
  const [frameUrl, setFrameUrl] = useState<string>("");
  const [urlBar, setUrlBar] = useState("https://example.com");
  const [imeText, setImeText] = useState("");
  const [showImeBar, setShowImeBar] = useState(false);
  const [controlling, setControlling] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [working, setWorking] = useState(false);
  const [stageFocused, setStageFocused] = useState(false);
  const [trackHoverMove, setTrackHoverMove] = useState(false);
  const [windowWidth, setWindowWidth] = useState<number | null>(null);

  const areaRef = useRef<HTMLDivElement | null>(null);
  const titlebarRef = useRef<HTMLDivElement | null>(null);
  const navbarRef = useRef<HTMLDivElement | null>(null);
  const imeBarRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const isPointerDownRef = useRef(false);
  const lastMoveSentAtRef = useRef(0);
  const composingRef = useRef(false);

  const measureChromeHeight = () => {
    const titleH = titlebarRef.current?.getBoundingClientRect().height ?? 0;
    const navH = navbarRef.current?.getBoundingClientRect().height ?? 0;
    const imeH = imeBarRef.current?.getBoundingClientRect().height ?? 0;
    return Math.ceil(titleH + navH + imeH) + 2;
  };

  useEffect(() => {
    const unsubscribe = api.subscribeBrowserStream(
      (evt) => {
        setStreamError("");
        if (evt.type === "status") {
          setStatus(evt.status);
          onPendingTakeoverChange(evt.status.pendingTakeover);
          if (evt.status.url && !document.activeElement?.getAttribute("data-url-bar")) {
            setUrlBar(evt.status.url);
          }
          if (!evt.status.open) {
            setFrameUrl("");
            setControlling(false);
            setIsFullscreen(false);
          }
        } else if (evt.type === "frame") {
          setFrameUrl(evt.dataUrl);
        }
      },
      (err) => {
        setStreamError(err.message);
      },
    );

    return () => unsubscribe();
  }, []);

  // Keep the outer browser chrome matched 1:1 with the rendered viewport size.
  useLayoutEffect(() => {
    const container = areaRef.current;
    if (!container || !status.open) {
      setWindowWidth(null);
      return;
    }

    const ratio =
      status.viewport.width > 0 && status.viewport.height > 0
        ? status.viewport.width / status.viewport.height
        : 1280 / 800;

    const recalc = () => {
      const rect = container.getBoundingClientRect();
      const availW = Math.max(280, Math.floor(rect.width));
      const chromeHeight = measureChromeHeight();
      const availContentH = Math.max(220, Math.floor(rect.height) - chromeHeight);
      const maxWidthByHeight = Math.floor(availContentH * ratio);
      setWindowWidth(Math.min(availW, Math.max(280, maxWidthByHeight)));
    };

    recalc();
    const observer = new ResizeObserver(recalc);
    observer.observe(container);
    if (titlebarRef.current) observer.observe(titlebarRef.current);
    if (navbarRef.current) observer.observe(navbarRef.current);
    if (imeBarRef.current) observer.observe(imeBarRef.current);
    return () => observer.disconnect();
  }, [status.open, status.viewport.width, status.viewport.height, showImeBar, isFullscreen]);

  const runAction = async (
    payload: Parameters<typeof api.browserAction>[0],
    successMsg?: string,
  ) => {
    setWorking(true);
    try {
      const res = await api.browserAction(payload);
      setStatus(res.status);
      onPendingTakeoverChange(res.status.pendingTakeover);
      if (res.status.url) setUrlBar(res.status.url);
      if (successMsg) onToast({ title: successMsg, status: "success" });
    } catch (err) {
      onToast({
        title: "浏览器操作失败",
        description: err instanceof Error ? err.message : String(err),
        status: "error",
      });
    } finally {
      setWorking(false);
    }
  };

  const enterTakeoverControl = async () => {
    await runAction({ action: "takeover" });
    setControlling(true);
    setTimeout(() => stageRef.current?.focus(), 20);
  };

  const exitTakeoverControl = async () => {
    setControlling(false);
    isPointerDownRef.current = false;
    await runAction({ action: "release_takeover" });
  };

  const toggleMaximizeFullscreen = async () => {
    const next = !isFullscreen;
    setIsFullscreen(next);
    if (next) {
      const chromeHeight = measureChromeHeight();
      const targetW = Math.max(1280, Math.min(1920, Math.floor(window.innerWidth - 28)));
      const targetH = Math.max(
        720,
        Math.min(1080, Math.floor(window.innerHeight - chromeHeight - 28)),
      );
      await runAction({ action: "resize", width: targetW, height: targetH });
    } else {
      await runAction({ action: "resize", width: 1280, height: 800 });
    }
  };

  useEffect(() => {
    if (!isFullscreen) return;
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) {
        setIsFullscreen(false);
        void runAction({ action: "resize", width: 1280, height: 800 });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isFullscreen]);

  const toViewportCoords = (e: { clientX: number; clientY: number }) => {
    const target = imgRef.current ?? stageRef.current;
    if (!target) return null;
    const rect = target.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const relX = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const relY = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
    return {
      x: Math.round(relX * status.viewport.width),
      y: Math.round(relY * status.viewport.height),
    };
  };

  const sendMouse = (
    payload: Extract<Parameters<typeof api.browserInput>[0], { kind: "mouse" }>,
  ) => {
    if (!status.open || !controlling) return;
    void api.browserInput(payload).catch((err) => {
      onToast({
        title: "鼠标控制失败",
        description: err instanceof Error ? err.message : String(err),
        status: "error",
      });
    });
  };

  const handlePointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (!status.open || !controlling) return;
    stageRef.current?.focus();
    const coords = toViewportCoords(e);
    if (!coords) return;
    isPointerDownRef.current = true;
    const button = e.button === 2 ? "right" : e.button === 1 ? "middle" : "left";
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // ignore unsupported capture
    }
    sendMouse({ kind: "mouse", action: "down", x: coords.x, y: coords.y, button });
  };

  const handlePointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!status.open || !controlling) return;
    if (!isPointerDownRef.current && !trackHoverMove) return;
    const now = performance.now();
    if (now - lastMoveSentAtRef.current < 45) return;
    lastMoveSentAtRef.current = now;
    const coords = toViewportCoords(e);
    if (!coords) return;
    sendMouse({ kind: "mouse", action: "move", x: coords.x, y: coords.y });
  };

  const handlePointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!status.open || !controlling || !isPointerDownRef.current) return;
    isPointerDownRef.current = false;
    const coords = toViewportCoords(e);
    if (!coords) return;
    const button = e.button === 2 ? "right" : e.button === 1 ? "middle" : "left";
    sendMouse({ kind: "mouse", action: "up", x: coords.x, y: coords.y, button });
  };

  const handleWheel = (e: WheelEvent<HTMLDivElement>) => {
    if (!status.open || !controlling) return;
    e.preventDefault();
    const coords = toViewportCoords(e);
    if (!coords) return;
    sendMouse({
      kind: "mouse",
      action: "wheel",
      x: coords.x,
      y: coords.y,
      deltaX: Math.round(e.deltaX),
      deltaY: Math.round(e.deltaY),
    });
  };

  const handleStageKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!status.open || !controlling || composingRef.current) return;
    const mapped = mapBrowserKey(e);
    if (!mapped) return;
    e.preventDefault();
    void api
      .browserInput(
        mapped.type === "press"
          ? { kind: "keyboard", action: "press", key: mapped.value }
          : { kind: "keyboard", action: "insertText", text: mapped.value },
      )
      .catch(() => undefined);
  };

  const sendImeText = async (withEnter: boolean) => {
    if (!status.open || !controlling || !imeText) return;
    try {
      await api.browserInput({ kind: "keyboard", action: "insertText", text: imeText });
      if (withEnter) {
        await api.browserInput({ kind: "keyboard", action: "press", key: "Enter" });
      }
      setImeText("");
    } catch (err) {
      onToast({
        title: "文本输入失败",
        description: err instanceof Error ? err.message : String(err),
        status: "error",
      });
    }
  };

  const displayLabel =
    status.displayMode === "xvfb"
      ? `Xvfb ${status.xvfbDisplay ?? "虚拟屏幕"}`
      : status.displayMode === "headed"
        ? "本地窗口"
        : status.displayMode === "headless"
          ? "无头窗口"
          : "未启动";

  const isHttps = (status.url ?? urlBar).startsWith("https://");

  const takeoverControls = !controlling ? (
    <Button
      type="button"
      size="sm"
      disabled={working}
      onClick={() => void enterTakeoverControl()}
      className="h-7 px-2.5 text-xs"
    >
      <Hand className="size-3.5" />
      接管操作
    </Button>
  ) : status.pendingTakeover ? (
    <Button
      type="button"
      size="sm"
      disabled={working}
      onClick={async () => {
        setControlling(false);
        await runAction({ action: "resume_takeover" });
        onGoToChatAndResume();
      }}
      className="h-7 px-2.5 text-xs"
    >
      <CheckCircle2 className="size-3.5" />
      完成接管并继续
    </Button>
  ) : (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      disabled={working}
      onClick={() => void exitTakeoverControl()}
      className="h-7 px-2.5 text-xs"
    >
      结束接管
    </Button>
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {streamError && (
        <Alert variant="destructive" open>
          <AlertIcon />
          <AlertContent>
            <AlertTitle>画面连接异常</AlertTitle>
            <AlertDescription>{streamError}</AlertDescription>
          </AlertContent>
        </Alert>
      )}

      {status.open && status.pendingTakeover && !controlling && (
        <Alert variant="warning" open>
          <AlertIcon />
          <AlertContent>
            <AlertTitle>需要手动操作：{status.takeoverReason || "请在画面中完成校验"}</AlertTitle>
            <AlertDescription>
              点击「接管操作」后即可直接在浏览器画面中点击、拖拽或输入内容。
            </AlertDescription>
            <AlertAction>{takeoverControls}</AlertAction>
          </AlertContent>
        </Alert>
      )}

      {!status.open ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="flex w-full max-w-lg flex-col items-center gap-5 rounded-2xl border border-border/75 bg-card/45 px-7 py-9 text-center shadow-sm">
            <div className="flex flex-col items-center gap-3">
              <div className="grid size-12 place-items-center rounded-2xl border border-border/70 bg-muted/50 text-muted-foreground">
                <MousePointerClick className="size-5" />
              </div>
              <AnimatedBadge status="neutral" size="sm">
                {displayLabel}
              </AnimatedBadge>
            </div>
            <div className="space-y-1.5">
              <h3 className="text-base font-semibold tracking-tight text-foreground">浏览器尚未启动</h3>
              <p className="text-xs leading-relaxed text-muted-foreground">
                输入初始网址后启动浏览器，可预先登录站点保留会话，或在执行任务时实时查看与接管画面。
              </p>
            </div>
            <form
              className="flex w-full flex-col items-stretch gap-2 sm:flex-row sm:items-center"
              onSubmit={(e) => {
                e.preventDefault();
                if (!urlBar.trim()) return;
                void runAction({ action: "open", url: urlBar.trim() }, "浏览器已启动");
              }}
            >
              <div className="flex-1">
                <ConsoleInput
                  size="sm"
                  data-url-bar="true"
                  value={urlBar}
                  onChange={setUrlBar}
                  leftIcon={<Globe className="size-3.5" />}
                  placeholder="https://example.com"
                />
              </div>
              <Button type="submit" size="sm" disabled={working}>
                启动浏览器
              </Button>
            </form>
          </div>
        </div>
      ) : (
        <div
          ref={areaRef}
          className={
            isFullscreen
              ? "fixed inset-0 z-50 flex flex-col items-center justify-center overflow-hidden bg-background/95 p-3 backdrop-blur-xs"
              : "flex min-h-0 flex-1 flex-col items-center justify-center overflow-hidden p-1"
          }
        >
          <div
            style={windowWidth ? { width: `${windowWidth}px` } : undefined}
            className={`flex max-w-full flex-col overflow-hidden rounded-lg border bg-background transition-colors ${
              controlling && stageFocused ? "border-primary ring-1 ring-primary/35" : "border-border"
            }`}
          >
            {/* Unified Titlebar: Traffic Lights + Tabs + Status + Takeover Controls */}
            <div
              ref={titlebarRef}
              className="flex min-h-10 shrink-0 flex-wrap items-center gap-2 border-b border-border bg-muted/30 px-2.5 py-1 select-none"
            >
              <div className="group flex shrink-0 items-center gap-2 pr-1">
                <button
                  type="button"
                  title="关闭浏览器"
                  aria-label="关闭浏览器"
                  disabled={working}
                  onClick={() => void runAction({ action: "close" }, "浏览器已关闭")}
                  className="grid size-3 place-items-center rounded-full bg-[#FF5F57] text-[#590000]/0 transition-colors hover:text-[#590000]/90"
                >
                  <X className="size-2 stroke-[2.5]" />
                </button>
                <button
                  type="button"
                  title={isFullscreen ? "还原浏览器窗口" : "最大化浏览器"}
                  aria-label={isFullscreen ? "还原浏览器窗口" : "最大化浏览器"}
                  disabled={working}
                  onClick={() => void toggleMaximizeFullscreen()}
                  className="grid size-3 place-items-center rounded-full bg-[#28C840] text-[#004D0F]/0 transition-colors hover:text-[#004D0F]/90"
                >
                  {isFullscreen ? (
                    <Minimize2 className="size-1.5 stroke-[2.5]" />
                  ) : (
                    <Maximize2 className="size-1.5 stroke-[2.5]" />
                  )}
                </button>
              </div>

              {/* Integrated Tabs */}
              <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
                {status.tabs.map((tab) => (
                  <div
                    key={tab.index}
                    className={`group/tab inline-flex h-7 max-w-[180px] shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs transition-colors ${
                      tab.active
                        ? "bg-background font-medium text-foreground ring-1 ring-border/70"
                        : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => void runAction({ action: "switch_tab", index: tab.index })}
                      className="min-w-0 flex-1 truncate text-left"
                      title={tab.url}
                    >
                      {tab.title || tab.url || `标签页 ${tab.index + 1}`}
                    </button>
                    <button
                      type="button"
                      aria-label="关闭标签页"
                      disabled={working}
                      onClick={() => void runAction({ action: "close_tab", index: tab.index })}
                      className="grid size-4 shrink-0 place-items-center rounded-full opacity-60 hover:bg-muted hover:opacity-100 disabled:pointer-events-none disabled:opacity-30"
                    >
                      <X className="size-2.5" />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  aria-label="新建标签页"
                  title="新建标签页"
                  disabled={working}
                  onClick={() => void runAction({ action: "new_tab" })}
                  className="grid size-6.5 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                >
                  <Plus className="size-3.5" />
                </button>
              </div>

              {/* Shared Status Badges + Takeover Controls */}
              <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                <AnimatedBadge status="success" size="sm" pulse>
                  {displayLabel}
                </AnimatedBadge>
                {status.busy && (
                  <AnimatedBadge status="loading" size="sm">
                    任务中
                  </AnimatedBadge>
                )}
                {controlling && (
                  <>
                    <AnimatedBadge status="info" size="sm">
                      已接管操作
                    </AnimatedBadge>
                    <label className="hidden items-center gap-1.5 text-[11px] text-muted-foreground md:flex">
                      <span>悬停指针</span>
                      <Switch
                        checked={trackHoverMove}
                        onCheckedChange={setTrackHoverMove}
                        ariaLabel="悬停同步指针"
                      />
                    </label>
                  </>
                )}
                {takeoverControls}
                <Button
                  type="button"
                  variant={showImeBar ? "secondary" : "ghost"}
                  size="sm"
                  onClick={() => setShowImeBar((v) => !v)}
                  className="h-7 px-2 text-xs"
                >
                  <Keyboard className="size-3.5" />
                  文本输入
                </Button>
              </div>
            </div>

            {/* Row 2: Simplified Navigation Bar */}
            <div
              ref={navbarRef}
              className="flex min-h-10 shrink-0 items-center gap-1.5 border-b border-border bg-background px-2.5 py-1"
            >
              <button
                type="button"
                disabled={working}
                aria-label="后退"
                title="后退"
                onClick={() => void runAction({ action: "back" })}
                className="grid size-7.5 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
              >
                <ArrowLeft className="size-3.5" />
              </button>
              <button
                type="button"
                disabled={working}
                aria-label="前进"
                title="前进"
                onClick={() => void runAction({ action: "forward" })}
                className="grid size-7.5 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
              >
                <ArrowRight className="size-3.5" />
              </button>
              <button
                type="button"
                disabled={working}
                aria-label="刷新页面"
                title="刷新页面"
                onClick={() => void runAction({ action: "reload" })}
                className="grid size-7.5 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
              >
                <RotateCw className="size-3.5" />
              </button>

              <form
                className="flex min-w-0 flex-1 items-center gap-1.5"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!urlBar.trim()) return;
                  void runAction({ action: "navigate", url: urlBar.trim() });
                }}
              >
                <div className="flex h-7.5 min-w-0 flex-1 items-center gap-2 rounded-lg border border-transparent bg-muted/40 px-2.5 transition-colors focus-within:border-border focus-within:bg-background">
                  {isHttps ? (
                    <Lock className="size-3 shrink-0 text-muted-foreground" />
                  ) : (
                    <Globe className="size-3 shrink-0 text-muted-foreground" />
                  )}
                  <input
                    data-url-bar="true"
                    type="text"
                    value={urlBar}
                    onChange={(e) => setUrlBar(e.target.value)}
                    placeholder="https://example.com"
                    className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground/60"
                  />
                </div>
                <Button type="submit" size="sm" disabled={working} className="h-7.5 px-3">
                  打开网址
                </Button>
              </form>
            </div>

            {/* Row 3: Exact-fit Browser Viewport */}
            <div
              ref={stageRef}
              tabIndex={controlling ? 0 : -1}
              aria-label="远程浏览器画面"
              style={{ aspectRatio: `${status.viewport.width} / ${status.viewport.height}` }}
              onFocus={() => setStageFocused(true)}
              onBlur={() => setStageFocused(false)}
              onContextMenu={(e) => e.preventDefault()}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onWheel={handleWheel}
              onKeyDown={handleStageKeyDown}
              onCompositionStart={() => {
                composingRef.current = true;
              }}
              onCompositionEnd={(e) => {
                composingRef.current = false;
                const text = e.data;
                if (text && status.open && controlling) {
                  void api
                    .browserInput({ kind: "keyboard", action: "insertText", text })
                    .catch(() => undefined);
                }
              }}
              className={`relative w-full touch-none select-none overflow-hidden bg-zinc-950 outline-none ${
                controlling ? "cursor-crosshair" : "cursor-default"
              }`}
            >
              {frameUrl ? (
                <img
                  ref={imgRef}
                  src={frameUrl}
                  alt={status.title || "远程浏览器画面"}
                  draggable={false}
                  className="block h-full w-full object-fill"
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center gap-2 text-xs text-zinc-400">
                  <RefreshCw className="size-4 animate-spin" />
                  {status.displayMode === "xvfb" ? "正在同步虚拟屏幕画面…" : "正在加载页面画面…"}
                </div>
              )}
            </div>

            {/* Optional Compact IME Bar flushed inside the bottom of the browser viewport */}
            {showImeBar && (
              <div
                ref={imeBarRef}
                className="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-t border-border bg-background px-3 py-1.5"
              >
                <div className="min-w-[180px] flex-1">
                  <ConsoleInput
                    size="sm"
                    disabled={!controlling}
                    value={imeText}
                    onChange={setImeText}
                    placeholder={
                      controlling
                        ? "先点选网页输入框，再输入中文或粘贴文本"
                        : "请先点击「接管操作」后再发送文本"
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        void sendImeText(e.metaKey || e.ctrlKey);
                      }
                    }}
                  />
                </div>
                <div className="flex items-center gap-1.5">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={!controlling || !imeText}
                    onClick={() => void sendImeText(false)}
                  >
                    <Send className="size-3.5" />
                    发送文本
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    disabled={!controlling || !imeText}
                    onClick={() => void sendImeText(true)}
                  >
                    <CornerDownLeft className="size-3.5" />
                    发送并回车
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
