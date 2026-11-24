import type { IncomingMessage, ServerResponse } from "node:http";
import type { BrowserRuntime } from "../browser/runtime.js";
import { readJsonBody, sendJson } from "./http-utils.js";

export interface BrowserRoutesDeps {
  getBrowserRuntime(): BrowserRuntime;
}

export async function handleBrowserStatus(
  deps: BrowserRoutesDeps,
  res: ServerResponse,
): Promise<void> {
  const status = await deps.getBrowserRuntime().getInteractiveStatus();
  sendJson(res, 200, { ok: true, status });
}

export function handleBrowserStream(
  deps: BrowserRoutesDeps,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  res.write(": connected\n\n");

  const browser = deps.getBrowserRuntime();
  const unsubscribe = browser.subscribeStream((event) => {
    if (res.writableEnded) return;
    if (event.type === "status") {
      res.write(`data: ${JSON.stringify({ type: "status", status: { ...event.status, busy: browser.isBusy() } })}\n\n`);
    } else {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  });

  const keepAlive = setInterval(() => {
    if (!res.writableEnded) {
      res.write(": ping\n\n");
    }
  }, 15_000);
  keepAlive.unref();

  const cleanup = () => {
    clearInterval(keepAlive);
    unsubscribe();
    if (!res.writableEnded) res.end();
  };
  req.once("close", cleanup);
  res.once("close", cleanup);
}

export async function handleBrowserScreenshot(
  deps: BrowserRoutesDeps,
  res: ServerResponse,
): Promise<void> {
  const buf = await deps.getBrowserRuntime().captureScreenshot();
  if (!buf) {
    sendJson(res, 404, { ok: false, error: "浏览器尚未打开" });
    return;
  }
  res.writeHead(200, {
    "Content-Type": "image/jpeg",
    "Content-Length": buf.byteLength,
    "Cache-Control": "no-store",
  });
  res.end(buf);
}

export async function handleBrowserAction(
  deps: BrowserRoutesDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = (await readJsonBody(req)) as {
    action?: unknown;
    url?: unknown;
    index?: unknown;
    width?: unknown;
    height?: unknown;
  };
  const action = typeof body.action === "string" ? body.action.trim() : "";
  const browser = deps.getBrowserRuntime();

  let status;
  switch (action) {
    case "open":
      status = await browser.openBrowser();
      if (typeof body.url === "string" && body.url.trim()) {
        status = await browser.navigateManual(body.url);
      }
      break;
    case "close":
      status = await browser.closeBrowser();
      break;
    case "navigate":
      if (typeof body.url !== "string" || !body.url.trim()) {
        sendJson(res, 400, { ok: false, error: "缺少 url 参数" });
        return;
      }
      status = await browser.navigateManual(body.url);
      break;
    case "back":
      status = await browser.goBackManual();
      break;
    case "forward":
      status = await browser.goForwardManual();
      break;
    case "reload":
      status = await browser.reloadManual();
      break;
    case "new_tab":
      status = await browser.newTabManual(typeof body.url === "string" ? body.url : undefined);
      break;
    case "switch_tab":
      status = await browser.switchTabManual(Number(body.index ?? 0));
      break;
    case "close_tab":
      status = await browser.closeTabManual(Number(body.index ?? 0));
      break;
    case "resize": {
      const w = Number(body.width);
      const h = Number(body.height);
      if (!Number.isFinite(w) || !Number.isFinite(h)) {
        sendJson(res, 400, { ok: false, error: "缺少有效 width/height 参数" });
        return;
      }
      status = await browser.resizeViewportManual(w, h);
      break;
    }
    case "takeover":
      status = await browser.beginManualControl();
      break;
    case "release_takeover":
      status = await browser.endManualControl();
      break;
    case "resume_takeover":
      status = await browser.resumeTakeover();
      break;
    default:
      sendJson(res, 400, { ok: false, error: `未知浏览器动作: ${action}` });
      return;
  }

  sendJson(res, 200, { ok: true, status });
}

export async function handleBrowserInput(
  deps: BrowserRoutesDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = (await readJsonBody(req)) as {
    kind?: unknown;
    action?: unknown;
    x?: unknown;
    y?: unknown;
    button?: unknown;
    deltaX?: unknown;
    deltaY?: unknown;
    key?: unknown;
    text?: unknown;
  };
  const kind = body.kind;
  const browser = deps.getBrowserRuntime();

  if (kind === "mouse") {
    const action = typeof body.action === "string" ? body.action : "";
    if (!["move", "down", "up", "click", "dblclick", "wheel"].includes(action)) {
      sendJson(res, 400, { ok: false, error: `无效鼠标动作: ${action}` });
      return;
    }
    const button =
      body.button === "right" || body.button === "middle" || body.button === "left"
        ? body.button
        : "left";
    await browser.dispatchMouse({
      action: action as "move" | "down" | "up" | "click" | "dblclick" | "wheel",
      x: typeof body.x === "number" ? body.x : Number(body.x),
      y: typeof body.y === "number" ? body.y : Number(body.y),
      button,
      deltaX: typeof body.deltaX === "number" ? body.deltaX : Number(body.deltaX) || 0,
      deltaY: typeof body.deltaY === "number" ? body.deltaY : Number(body.deltaY) || 0,
    });
    sendJson(res, 200, { ok: true });
    return;
  }

  if (kind === "keyboard") {
    const action = typeof body.action === "string" ? body.action : "";
    if (!["press", "down", "up", "insertText"].includes(action)) {
      sendJson(res, 400, { ok: false, error: `无效键盘动作: ${action}` });
      return;
    }
    await browser.dispatchKeyboard({
      action: action as "press" | "down" | "up" | "insertText",
      key: typeof body.key === "string" ? body.key : undefined,
      text: typeof body.text === "string" ? body.text : undefined,
    });
    sendJson(res, 200, { ok: true });
    return;
  }

  sendJson(res, 400, { ok: false, error: `未知输入类型: ${String(kind)}` });
}
