import {
  Bot,
  Eye,
  FastForward,
  FilePenLine,
  Hand,
  Laptop,
  Monitor,
  Moon,
  ShieldAlert,
  ShieldCheck,
  Sun,
  Terminal,
} from "lucide-react";
import { motion } from "motion/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { HatoConfig } from "@/api";
import { ConsoleInput, type ConsoleInputProps } from "@/components/console/ConsolePrimitives";
import { isWorkerBackendEnabledInConfig } from "@/components/console/settings/types";
import { cn } from "@/lib/utils";

export const WORKER_BACKEND_OPTIONS = [
  { value: "codex-cli", label: "Codex CLI", icon: <Terminal className="size-3.5 text-muted-foreground" /> },
  { value: "antigravity-cli", label: "Antigravity CLI", icon: <Terminal className="size-3.5 text-muted-foreground" /> },
  { value: "opencode-v2", label: "OpenCode V2", icon: <Terminal className="size-3.5 text-muted-foreground" /> },
  { value: "external-pi", label: "独立 Pi CLI", icon: <Terminal className="size-3.5 text-muted-foreground" /> },
  { value: "claude-code", label: "Claude Code", icon: <Terminal className="size-3.5 text-muted-foreground" /> },
  { value: "builtin-pi", label: "内置沙箱 Worker", icon: <Bot className="size-3.5 text-muted-foreground" /> },
];

export function listEnabledBackendOptions(cfg: HatoConfig) {
  return WORKER_BACKEND_OPTIONS.filter((opt) =>
    isWorkerBackendEnabledInConfig(cfg, opt.value as HatoConfig["worker"]["default_backend"]),
  );
}

export const PERMISSION_PRESET_OPTIONS = [
  { value: "auto_safe", label: "自动审批", icon: <ShieldCheck className="size-3.5 text-emerald-500" /> },
  { value: "yolo", label: "完全访问", icon: <ShieldAlert className="size-3.5 text-amber-500" /> },
  { value: "follow_host", label: "跟随本机", icon: <Laptop className="size-3.5 text-muted-foreground" /> },
  { value: "read_only", label: "只读模式", icon: <Eye className="size-3.5 text-sky-500" /> },
];

export const CLI_CHOICE_ICONS: Record<string, ReactNode> = {
  "read-only": <Eye className="size-3.5 text-sky-500" />,
  plan: <Eye className="size-3.5 text-sky-500" />,
  "workspace-write": <Hand className="size-3.5 text-muted-foreground" />,
  ask: <Hand className="size-3.5 text-muted-foreground" />,
  default: <Hand className="size-3.5 text-muted-foreground" />,
  manual: <Hand className="size-3.5 text-muted-foreground" />,
  "accept-edits": <FilePenLine className="size-3.5 text-blue-500" />,
  acceptEdits: <FilePenLine className="size-3.5 text-blue-500" />,
  "approve-for-me": <ShieldCheck className="size-3.5 text-emerald-500" />,
  auto: <ShieldCheck className="size-3.5 text-emerald-500" />,
  "danger-full-access": <ShieldAlert className="size-3.5 text-amber-500" />,
  full_access: <ShieldAlert className="size-3.5 text-amber-500" />,
  bypass: <ShieldAlert className="size-3.5 text-amber-500" />,
  "skip-permissions": <ShieldAlert className="size-3.5 text-amber-500" />,
  bypassPermissions: <ShieldAlert className="size-3.5 text-amber-500" />,
  host: <Laptop className="size-3.5 text-muted-foreground" />,
  dontAsk: <FastForward className="size-3.5 text-muted-foreground" />,
};

export const THEME_OPTIONS = [
  { value: "system", label: "跟随系统", icon: <Monitor className="size-3.5 text-muted-foreground" /> },
  { value: "dark", label: "深色", icon: <Moon className="size-3.5 text-muted-foreground" /> },
  { value: "light", label: "浅色", icon: <Sun className="size-3.5 text-muted-foreground" /> },
];

export function SettingsCardGroup({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <motion.section layout className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
          {description ? (
            <p className="mt-0.5 text-[11px] text-muted-foreground/80">{description}</p>
          ) : null}
        </div>
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </div>
      <div className="divide-y divide-border/70 rounded-xl border border-border/80 bg-card/60">
        {children}
      </div>
    </motion.section>
  );
}

export function SettingsRow({
  title,
  description,
  children,
  alignTop = false,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  alignTop?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:justify-between sm:gap-6",
        alignTop ? "sm:items-start" : "sm:items-center",
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-foreground">{title}</div>
        {description ? (
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</p>
        ) : null}
      </div>
      <div className="shrink-0 sm:flex sm:justify-end">{children}</div>
    </div>
  );
}

export function NumericConsoleInput({
  value,
  fallback,
  min,
  onCommit,
  onBlur,
  onFocus,
  ...props
}: Omit<ConsoleInputProps, "value" | "onChange" | "type"> & {
  value: number;
  fallback: number;
  min?: number;
  onCommit: (next: number) => void;
}) {
  const [text, setText] = useState(() => String(value));
  const focusedRef = useRef(false);

  useEffect(() => {
    if (!focusedRef.current) {
      setText(String(value));
    }
  }, [value]);

  return (
    <ConsoleInput
      {...props}
      type="number"
      value={text}
      onFocus={(e) => {
        focusedRef.current = true;
        onFocus?.(e);
      }}
      onChange={(v) => {
        setText(v);
        const trimmed = v.trim();
        if (trimmed === "") return;
        const parsed = Number(trimmed);
        if (!Number.isFinite(parsed)) return;
        if (min !== undefined && parsed < min) return;
        onCommit(parsed);
      }}
      onBlur={(e) => {
        focusedRef.current = false;
        const trimmed = text.trim();
        const parsed = trimmed === "" ? NaN : Number(trimmed);
        const committed =
          !Number.isFinite(parsed) || (min !== undefined && parsed < min) ? fallback : parsed;
        setText(String(committed));
        onCommit(committed);
        onBlur?.(e);
      }}
    />
  );
}
