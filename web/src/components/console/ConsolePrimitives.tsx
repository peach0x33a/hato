import { Check, ChevronDown, Plus } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { type ReactNode, useCallback, useMemo, useRef, useState } from "react";
import { Input, type InputProps } from "@/components/motion/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/motion/select";
import { EASE_OUT } from "@/lib/ease";
import { useDismiss } from "@/lib/hooks/use-dismiss";
import { cn } from "@/lib/utils";

export interface ConsolePageHeaderProps {
  title: string;
  description?: ReactNode;
  badges?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

export function ConsolePageHeader({
  title,
  description,
  badges,
  actions,
  className,
}: ConsolePageHeaderProps) {
  return (
    <div
      className={cn(
        "flex min-h-11 shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border/80 pb-3.5",
        className,
      )}
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-[15px] font-semibold tracking-[-0.015em] text-foreground">
            {title}
          </h2>
          {badges}
        </div>
        {description ? (
          <p className="text-xs leading-relaxed text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export interface ConsoleSectionProps {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  bordered?: boolean;
  className?: string;
  contentClassName?: string;
}

/**
 * Flat content section separated by hairline dividers and whitespace instead of boxed cards.
 */
export function ConsoleSection({
  title,
  description,
  actions,
  children,
  bordered = true,
  className,
  contentClassName,
}: ConsoleSectionProps) {
  return (
    <section
      className={cn(
        "flex flex-col gap-3",
        bordered && "border-b border-border/75 pb-6 last:border-b-0 last:pb-0",
        className,
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h3 className="text-xs font-semibold tracking-wide text-foreground">{title}</h3>
          {description ? (
            <p className="text-[11px] leading-relaxed text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
      <div className={cn("min-w-0", contentClassName)}>{children}</div>
    </section>
  );
}

export interface ConsoleFormRowProps {
  label: ReactNode;
  description?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}

/**
 * Responsive two-column setting row for flat configuration panels.
 */
export function ConsoleFormRow({
  label,
  description,
  htmlFor,
  children,
  className,
}: ConsoleFormRowProps) {
  return (
    <div
      className={cn(
        "grid grid-cols-1 gap-2 py-3 md:grid-cols-[minmax(0,240px)_minmax(0,1fr)] md:items-start md:gap-6",
        className,
      )}
    >
      <div className="flex min-w-0 flex-col gap-0.5 md:pt-1.5">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="text-xs font-medium text-foreground">
            {label}
          </label>
        ) : (
          <span className="text-xs font-medium text-foreground">{label}</span>
        )}
        {description ? (
          <p className="text-[11px] leading-relaxed text-muted-foreground">{description}</p>
        ) : null}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export interface ConsoleSelectOption {
  value: string;
  label: string;
  hint?: string;
  icon?: ReactNode;
}

export interface ConsoleSelectProps {
  label?: string;
  value: string;
  onValueChange: (value: string) => void;
  options: ConsoleSelectOption[];
  placeholder?: string;
  size?: "sm" | "md";
  disabled?: boolean;
  className?: string;
  triggerClassName?: string;
}

export function ConsoleSelect({
  label,
  value,
  onValueChange,
  options,
  placeholder,
  size = "md",
  disabled,
  className,
  triggerClassName,
}: ConsoleSelectProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className={cn("flex flex-col gap-1.5", open ? "relative z-40" : "relative z-10", className)}>
      {label ? (
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
      ) : null}
      <Select
        value={value}
        onValueChange={onValueChange}
        open={open}
        onOpenChange={setOpen}
        disabled={disabled}
      >
        <SelectTrigger
          className={cn(
            "border-input bg-transparent px-2.5 py-0 text-xs transition-colors hover:bg-muted/35",
            open && "bg-background",
            size === "sm" ? "h-8" : "h-9",
            triggerClassName,
          )}
        >
          <SelectValue placeholder={placeholder} className="text-xs" />
        </SelectTrigger>
        <SelectContent className="z-50 shadow-sm">
          {options.map((opt) => (
            <SelectItem
              key={opt.value}
              value={opt.value}
              label={opt.label}
              icon={opt.icon}
              className="text-xs"
            >
              {opt.hint ? (
                <span className="inline-flex min-w-0 items-baseline gap-1.5">
                  <span className="truncate font-medium text-foreground">{opt.label}</span>
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                    {opt.hint}
                  </span>
                </span>
              ) : (
                opt.label
              )}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export interface ConsoleMultiSelectProps {
  label?: string;
  values: string[];
  onValuesChange: (values: string[]) => void;
  options: ConsoleSelectOption[];
  placeholder?: string;
  minSelected?: number;
  allowCustom?: boolean;
  customPlaceholder?: string;
  size?: "sm" | "md";
  disabled?: boolean;
  className?: string;
}

export function ConsoleMultiSelect({
  label,
  values,
  onValuesChange,
  options,
  placeholder = "请选择",
  minSelected = 1,
  allowCustom = false,
  customPlaceholder = "添加子范围（如 llm-calling.openai）",
  size = "md",
  disabled = false,
  className,
}: ConsoleMultiSelectProps) {
  const [open, setOpen] = useState(false);
  const [customDraft, setCustomDraft] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion() ?? false;

  const dismiss = useCallback(() => setOpen(false), []);
  useDismiss(open, dismiss, rootRef);

  const mergedOptions = useMemo(() => {
    const known = new Set(options.map((o) => o.value));
    const extras: ConsoleSelectOption[] = values
      .filter((v) => !known.has(v))
      .map((v) => ({ value: v, label: v }));
    return [...options, ...extras];
  }, [options, values]);

  const toggleValue = (val: string) => {
    const exists = values.includes(val);
    if (exists) {
      if (values.length <= minSelected) return;
      onValuesChange(values.filter((v) => v !== val));
    } else {
      onValuesChange([...values, val]);
    }
  };

  const addCustomValue = () => {
    const clean = customDraft.trim();
    if (!clean) return;
    if (!values.includes(clean)) {
      onValuesChange([...values, clean]);
    }
    setCustomDraft("");
  };

  const summaryText = values.length > 0 ? values.join(", ") : placeholder;

  return (
    <div
      ref={rootRef}
      className={cn("flex flex-col gap-1.5", open ? "relative z-40" : "relative z-10", className)}
    >
      {label ? (
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
      ) : null}

      <button
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => !disabled && setOpen((v) => !v)}
        className={cn(
          "flex w-full items-center justify-between gap-2 rounded-lg border border-input bg-transparent px-2.5 text-left text-xs text-foreground outline-none transition-colors",
          "hover:border-border-strong hover:bg-muted/35 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25",
          "disabled:pointer-events-none disabled:opacity-50",
          size === "sm" ? "h-8" : "h-9",
        )}
      >
        <span
          className={cn(
            "min-w-0 flex-1 truncate font-mono text-[11px]",
            values.length === 0 && "font-sans text-xs text-muted-foreground",
          )}
          title={values.join(", ")}
        >
          {summaryText}
        </span>
        {values.length > 0 && (
          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">
            {values.length}
          </span>
        )}
        <ChevronDown
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform duration-200",
            open && "rotate-180",
          )}
        />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            role="listbox"
            aria-multiselectable="true"
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: -4 }}
            transition={{ duration: 0.16, ease: EASE_OUT }}
            className="absolute top-full left-0 z-50 mt-1.5 w-full min-w-[260px] overflow-hidden rounded-lg border border-border bg-popover p-1 shadow-sm"
          >
            <div className="max-h-60 space-y-0.5 overflow-y-auto">
              {mergedOptions.map((opt) => {
                const checked = values.includes(opt.value);
                const locked = checked && values.length <= minSelected;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    role="option"
                    aria-selected={checked}
                    disabled={locked}
                    onClick={() => toggleValue(opt.value)}
                    className={cn(
                      "flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors outline-none",
                      checked
                        ? "bg-muted font-medium text-foreground"
                        : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                      locked && "cursor-not-allowed opacity-75",
                    )}
                  >
                    <span className="truncate">{opt.label}</span>
                    <span
                      className={cn(
                        "grid size-4 shrink-0 place-items-center rounded border transition-colors",
                        checked
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-border bg-background",
                      )}
                    >
                      {checked && <Check className="size-3" />}
                    </span>
                  </button>
                );
              })}
            </div>

            {allowCustom && (
              <div className="mt-1.5 flex items-center gap-1.5 border-t border-border/80 pt-1.5">
                <input
                  type="text"
                  value={customDraft}
                  onChange={(e) => setCustomDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addCustomValue();
                    }
                  }}
                  placeholder={customPlaceholder}
                  className="h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-2 font-mono text-[11px] text-foreground outline-none focus:border-ring"
                />
                <button
                  type="button"
                  onClick={addCustomValue}
                  disabled={!customDraft.trim()}
                  aria-label="添加自定义范围"
                  className="inline-flex h-7 items-center gap-1 rounded-md bg-primary px-2 text-[11px] font-medium text-primary-foreground disabled:opacity-40"
                >
                  <Plus className="size-3" />
                  添加
                </button>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export interface ConsoleInputProps extends Omit<InputProps, "classNames" | "size"> {
  size?: "sm" | "md";
}

export function ConsoleInput({ size = "md", className, ...props }: ConsoleInputProps) {
  return (
    <Input
      {...props}
      className={className}
      classNames={{
        label: "px-0 text-xs font-medium text-muted-foreground mb-1",
        field: cn(
          "rounded-lg border-input bg-transparent transition-colors hover:border-border-strong focus-within:bg-background",
          size === "sm" ? "h-8" : "h-9",
        ),
        input: "text-xs leading-normal",
      }}
    />
  );
}

import { SLOT_COLOR_MAP } from "@/components/console/models/types";

export function SlotBadge({ slot, className }: { slot: string; className?: string }) {
  const tone =
    SLOT_COLOR_MAP[slot]?.pillClass ?? "border-border/80 bg-muted/60 text-foreground";
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center rounded-md border px-1.5 font-mono text-[10px] font-medium leading-none",
        tone,
        className,
      )}
    >
      {slot}
    </span>
  );
}

const API_BADGE_STYLE: Record<string, string> = {
  "anthropic-messages": "border-orange-500/25 bg-orange-500/8 text-orange-700 dark:text-orange-300",
  "google-generative-ai": "border-blue-500/25 bg-blue-500/8 text-blue-700 dark:text-blue-300",
  "openai-responses": "border-emerald-500/25 bg-emerald-500/8 text-emerald-700 dark:text-emerald-300",
  "openai-completions": "border-teal-500/25 bg-teal-500/8 text-teal-700 dark:text-teal-300",
};

export function ApiBadge({ api, className }: { api: string; className?: string }) {
  const tone =
    API_BADGE_STYLE[api] ?? "border-border/80 bg-muted/50 text-muted-foreground";
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center rounded-md border px-1.5 font-mono text-[10px] leading-none",
        tone,
        className,
      )}
    >
      {api}
    </span>
  );
}
