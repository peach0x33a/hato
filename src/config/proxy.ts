import { AsyncLocalStorage } from "node:async_hooks";
import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import type { ProxyRuleConfig } from "./app.js";

export type ProxyResolution =
  | { mode: "direct"; matchedScope: string | null }
  | { mode: "proxy"; url: string; matchedScope: string };

const scopeStorage = new AsyncLocalStorage<string>();
const originalGlobalFetch = globalThis.fetch.bind(globalThis);

function buildScopeCandidates(scope: string): string[] {
  const clean = scope.trim();
  if (!clean || clean === "all") return ["all"];

  const segments = clean.split(".");
  const candidates: string[] = [];
  for (let i = segments.length; i >= 1; i--) {
    candidates.push(segments.slice(0, i).join("."));
  }
  candidates.push("all");
  return candidates;
}

function isSocksUrl(url: string): boolean {
  return /^socks(?:4|4a|5|5h)?:\/\//i.test(url);
}

/**
 * Resolves proxy settings by scope specificity without mutating global proxy env vars.
 * Priority: exact child scope (e.g. llm-calling.aliyun) -> parent scope -> "all" -> direct.
 */
export class ScopedProxyRouter {
  private rules: ProxyRuleConfig[] = [];
  private readonly nodeHttpAgents = new Map<string, http.Agent>();
  private readonly directHttpAgent = new http.Agent({ keepAlive: true });
  private readonly directHttpsAgent = new https.Agent({ keepAlive: true });
  private fetchInstalled = false;

  constructor(rules: ProxyRuleConfig[] = []) {
    this.reload(rules);
  }

  reload(rules: ProxyRuleConfig[] = []): void {
    this.rules = rules.map((rule) => ({
      ...rule,
      url: rule.url.trim(),
      scope: rule.scope.map((s) => s.trim()),
    }));

    this.nodeHttpAgents.clear();
  }

  resolveScope(scope: string): ProxyResolution {
    const candidates = buildScopeCandidates(scope);
    for (const candidate of candidates) {
      // Later rules with equal specificity win so overrides can live below base rules.
      for (let i = this.rules.length - 1; i >= 0; i--) {
        const rule = this.rules[i]!;
        if (!rule.scope.includes(candidate)) continue;
        if (rule.url.toLowerCase() === "direct") {
          return { mode: "direct", matchedScope: candidate };
        }
        return { mode: "proxy", url: rule.url, matchedScope: candidate };
      }
    }
    return { mode: "direct", matchedScope: null };
  }

  /**
   * Run an async function inside a bound proxy scope carried across all awaits.
   */
  runWithScope<T>(scope: string, fn: () => Promise<T>): Promise<T> {
    return scopeStorage.run(scope, fn);
  }

  getCurrentScope(): string {
    return scopeStorage.getStore() ?? "all";
  }

  /**
   * Install global fetch hook once so libraries using global fetch (like pi-ai)
   * automatically honor the active AsyncLocalStorage proxy scope.
   */
  installGlobalFetchHook(): void {
    if (this.fetchInstalled) return;
    globalThis.fetch = Object.assign(
      (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        return this.scopedFetch(input, init);
      },
      { preconnect: originalGlobalFetch.preconnect },
    );
    this.fetchInstalled = true;
  }

  /**
   * Create a `fetch`-compatible function bound to a fixed proxy scope.
   */
  createScopedFetch(scope: string): typeof globalThis.fetch {
    return Object.assign(
      (input: string | URL | Request, init?: RequestInit): Promise<Response> =>
        this.scopedFetch(input, init, scope),
      { preconnect: originalGlobalFetch.preconnect },
    );
  }

  uninstallGlobalFetchHook(): void {
    if (!this.fetchInstalled) return;
    globalThis.fetch = originalGlobalFetch;
    this.fetchInstalled = false;
  }

  isGlobalFetchHookInstalled(): boolean {
    return this.fetchInstalled;
  }

  /**
   * Return a Node http.Agent / ProxyAgent matching the given scope (used by grammY).
   */
  getNodeAgent(scope: string, targetProtocol: "http:" | "https:" = "https:"): http.Agent {
    const resolved = this.resolveScope(scope);
    if (resolved.mode === "direct") {
      return targetProtocol === "http:" ? this.directHttpAgent : this.directHttpsAgent;
    }

    const cached = this.nodeHttpAgents.get(resolved.url);
    if (cached) return cached;

    const agent = isSocksUrl(resolved.url)
      ? new SocksProxyAgent(resolved.url)
      : new HttpsProxyAgent(resolved.url);
    this.nodeHttpAgents.set(resolved.url, agent);
    return agent;
  }

  /**
   * Return proxy env map only when worker mandate permits outbound networking.
   */
  getWorkerProxyEnv(scope = "worker"): Record<string, string> {
    const resolved = this.resolveScope(scope);
    if (resolved.mode === "direct") return {};
    return {
      HTTP_PROXY: resolved.url,
      HTTPS_PROXY: resolved.url,
      ALL_PROXY: resolved.url,
      http_proxy: resolved.url,
      https_proxy: resolved.url,
      all_proxy: resolved.url,
    };
  }

  async scopedFetch(
    input: string | URL | Request,
    init?: RequestInit,
    explicitScope?: string,
  ): Promise<Response> {
    const scope = explicitScope ?? this.getCurrentScope();
    const resolved = this.resolveScope(scope);

    if (resolved.mode === "direct") {
      return originalGlobalFetch(input, init);
    }

    if (!isSocksUrl(resolved.url)) {
      const proxyInit = {
        ...init,
        proxy: resolved.url,
      } as RequestInit;
      return originalGlobalFetch(input, proxyInit);
    }

    return nodeFetchViaAgent(input, init, this.getNodeAgent(scope));
  }
}

async function nodeFetchViaAgent(
  input: string | URL | Request,
  init: RequestInit | undefined,
  agent: http.Agent,
): Promise<Response> {
  const reqObj =
    input instanceof Request
      ? input
      : new Request(input instanceof URL ? input.toString() : input, init);
  const url = new URL(reqObj.url);
  const transport = url.protocol === "http:" ? http : https;

  const headers: Record<string, string> = {};
  reqObj.headers.forEach((value, key) => {
    headers[key] = value;
  });

  const bodyBuf = reqObj.body ? Buffer.from(await reqObj.arrayBuffer()) : undefined;
  if (bodyBuf && !headers["content-length"]) {
    headers["content-length"] = String(bodyBuf.byteLength);
  }

  return new Promise<Response>((resolve, reject) => {
    const req = transport.request(
      url,
      {
        method: reqObj.method,
        headers,
        agent,
        signal: reqObj.signal,
      },
      (res) => {
        const responseHeaders = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (typeof v === "string") {
            responseHeaders.append(k, v);
          } else if (Array.isArray(v)) {
            for (const item of v) responseHeaders.append(k, item);
          }
        }
        const status = res.statusCode ?? 200;
        const body = status === 204 || status === 304 ? null : (Readable.toWeb(res) as ReadableStream);
        resolve(new Response(body, { status, statusText: res.statusMessage ?? "", headers: responseHeaders }));
      },
    );

    req.on("error", reject);
    if (bodyBuf && bodyBuf.byteLength > 0) {
      req.write(bodyBuf);
    }
    req.end();
  });
}
