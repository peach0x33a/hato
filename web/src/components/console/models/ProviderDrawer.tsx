import { type FormEvent, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  AlertCircle,
  Bookmark,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  KeyRound,
  Plus,
  RotateCcw,
  Sparkles,
  X,
} from "lucide-react";
import type { SecretState } from "@/api";
import { ConsoleSelect } from "@/components/console/ConsolePrimitives";
import {
  API_OPTIONS,
  deriveEnvName,
  parseHeadersJson,
  PROVIDER_PRESETS,
  type ProviderDraft,
  type ProviderPreset,
  type UiProviderConfig,
  validatePositiveIntInput,
} from "./types";

interface ProviderDrawerProps {
  open: boolean;
  mode: "create" | "edit";
  editingProvider?: UiProviderConfig | null;
  savedDraft: ProviderDraft | null;
  existingNames: string[];
  secretStates: SecretState[];
  pendingSecrets: Record<string, string>;
  onClose: () => void;
  onSaveDraft: (draft: ProviderDraft) => void;
  onDiscardDraft: () => void;
  onCreateProvider: (draft: ProviderDraft) => void;
  onUpdateProviderSettings: (
    uid: string,
    patch: {
      name: string;
      displayName: string;
      protocol: string;
      baseUrl: string;
      apiKeyEnv: string;
      apiKeyValue: string;
      cacheTtlMinutes: string;
      customHeaders: string;
    },
  ) => void;
}

const EMPTY_DRAFT: ProviderDraft = {
  name: "",
  displayName: "",
  protocol: "openai-completions",
  baseUrl: "",
  apiKeyEnv: "",
  apiKeyValue: "",
  cacheTtlMinutes: "",
  customHeaders: "",
  includeInitialModel: true,
  initialModelId: "",
  initialModelName: "",
  initialModelVision: false,
  initialModelThinking: false,
};

function defaultBaseUrlHint(protocol: string): string {
  switch (protocol) {
    case "anthropic-messages":
      return "https://api.anthropic.com/v1";
    case "google-generative-ai":
      return "https://generativelanguage.googleapis.com/v1beta";
    case "openai-responses":
      return "https://api.openai.com/v1";
    case "hato-faux-api":
      return "http://127.0.0.1:0/faux";
    case "openai-completions":
    default:
      return "https://api.deepseek.com/v1";
  }
}

export function ProviderDrawer({
  open,
  mode,
  editingProvider,
  savedDraft,
  existingNames,
  secretStates,
  pendingSecrets,
  onClose,
  onSaveDraft,
  onDiscardDraft,
  onCreateProvider,
  onUpdateProviderSettings,
}: ProviderDrawerProps) {
  const [form, setForm] = useState<ProviderDraft>(EMPTY_DRAFT);
  const [envManuallyEdited, setEnvManuallyEdited] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => {
      if (mode === "edit" && editingProvider) {
        const envKey = editingProvider.apiKeyEnv || deriveEnvName(editingProvider.name);
        setForm({
          name: editingProvider.name,
          displayName: editingProvider.displayName ?? "",
          protocol: editingProvider.protocol,
          baseUrl: editingProvider.baseUrl,
          apiKeyEnv: envKey,
          apiKeyValue: pendingSecrets[envKey] ?? "",
          cacheTtlMinutes: editingProvider.cacheTtlMinutes ?? "",
          customHeaders: editingProvider.customHeaders ?? "",
          includeInitialModel: false,
          initialModelId: "",
          initialModelName: "",
          initialModelVision: false,
          initialModelThinking: false,
        });
        setEnvManuallyEdited(true);
        setShowAdvanced(
          Boolean(
            editingProvider.displayName?.trim() ||
              editingProvider.cacheTtlMinutes.trim() ||
              editingProvider.customHeaders.trim(),
          ),
        );
      } else if (savedDraft) {
        setForm({ ...EMPTY_DRAFT, ...savedDraft });
        setEnvManuallyEdited(Boolean(savedDraft.apiKeyEnv));
        setShowAdvanced(
          Boolean(
            savedDraft.displayName?.trim() ||
              savedDraft.cacheTtlMinutes?.trim() ||
              savedDraft.customHeaders?.trim(),
          ),
        );
      } else {
        setForm(EMPTY_DRAFT);
        setEnvManuallyEdited(false);
        setShowAdvanced(false);
      }
      setShowApiKey(false);
      setValidationError(null);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [open, mode, editingProvider, savedDraft, pendingSecrets]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  const effectiveEnvKey = useMemo(
    () => form.apiKeyEnv.trim() || deriveEnvName(form.name),
    [form.apiKeyEnv, form.name],
  );

  const configuredSecretState = useMemo(
    () => secretStates.find((s) => s.key === effectiveEnvKey),
    [secretStates, effectiveEnvKey],
  );

  const handleApplyPreset = (preset: ProviderPreset) => {
    setValidationError(null);
    setForm((prev) => ({
      ...prev,
      name: preset.name,
      protocol: preset.protocol,
      baseUrl: preset.baseUrl,
      apiKeyEnv: preset.apiKeyEnv,
      includeInitialModel: true,
      initialModelId: preset.initialModelId,
      initialModelName: preset.initialModelName,
      initialModelVision: preset.initialModelVision,
      initialModelThinking: preset.initialModelThinking,
    }));
    setEnvManuallyEdited(false);
  };

  const handleNameChange = (nextName: string) => {
    setValidationError(null);
    setForm((prev) => ({
      ...prev,
      name: nextName,
      apiKeyEnv: envManuallyEdited ? prev.apiKeyEnv : deriveEnvName(nextName),
    }));
  };

  const handleResetToEmpty = () => {
    setForm(EMPTY_DRAFT);
    setEnvManuallyEdited(false);
    setShowAdvanced(false);
    setValidationError(null);
    onDiscardDraft();
  };

  const handleSaveDraftClick = () => {
    const draftPayload: ProviderDraft = {
      ...form,
      updatedAt: new Date().toLocaleTimeString("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
      }),
    };
    onSaveDraft(draftPayload);
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const trimmedName = form.name.trim();
    const trimmedUrl = form.baseUrl.trim();

    if (!trimmedName) {
      setValidationError("请填写供应商名称");
      return;
    }

    if (/\s|\//.test(trimmedName)) {
      setValidationError('供应商名称不能包含空格或 "/"');
      return;
    }

    const otherNames =
      mode === "edit" && editingProvider
        ? existingNames.filter(
            (n) => n.toLowerCase() !== editingProvider.name.toLowerCase(),
          )
        : existingNames;

    if (
      otherNames.some(
        (existing) => existing.toLowerCase() === trimmedName.toLowerCase(),
      )
    ) {
      setValidationError(`供应商 "${trimmedName}" 已存在，请更换名称`);
      return;
    }

    if (!trimmedUrl) {
      setValidationError("请填写 Base URL 接口地址");
      return;
    }

    if (form.cacheTtlMinutes.trim()) {
      const ttlRes = validatePositiveIntInput(form.cacheTtlMinutes, "缓存 TTL（分钟）");
      if (!ttlRes.ok) {
        setShowAdvanced(true);
        setValidationError(ttlRes.error);
        return;
      }
    }

    const headersRes = parseHeadersJson(form.customHeaders, "供应商默认请求头");
    if (!headersRes.ok) {
      setShowAdvanced(true);
      setValidationError(headersRes.error);
      return;
    }

    const resolvedEnv = form.apiKeyEnv.trim() || deriveEnvName(trimmedName);

    if (mode === "edit" && editingProvider) {
      onUpdateProviderSettings(editingProvider.uid, {
        name: trimmedName,
        displayName: form.displayName.trim(),
        protocol: form.protocol,
        baseUrl: trimmedUrl,
        apiKeyEnv: resolvedEnv,
        apiKeyValue: form.apiKeyValue.trim(),
        cacheTtlMinutes: form.cacheTtlMinutes.trim(),
        customHeaders: form.customHeaders.trim(),
      });
      return;
    }

    if (form.includeInitialModel && !form.initialModelId.trim()) {
      setValidationError("已启用创建首个模型，请填写模型 ID 或取消勾选");
      return;
    }

    if (form.includeInitialModel && /\s/.test(form.initialModelId.trim())) {
      setValidationError("模型 ID 不能包含空白字符");
      return;
    }

    onCreateProvider({
      ...form,
      name: trimmedName,
      displayName: form.displayName.trim(),
      baseUrl: trimmedUrl,
      apiKeyEnv: resolvedEnv,
      apiKeyValue: form.apiKeyValue.trim(),
      cacheTtlMinutes: form.cacheTtlMinutes.trim(),
      customHeaders: form.customHeaders.trim(),
      initialModelId: form.initialModelId.trim(),
      initialModelName:
        form.initialModelName.trim() || form.initialModelId.trim(),
    });
  };

  const isEdit = mode === "edit";

  return (
    <AnimatePresence>
      {open ? (
        <div
          className="fixed inset-0 z-50 flex justify-end"
          role="dialog"
          aria-modal="true"
          aria-labelledby="provider-drawer-title"
        >
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.16 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/55 backdrop-blur-[2px]"
          />

          {/* Slide-over Panel */}
          <motion.aside
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            className="relative z-10 flex h-full w-full max-w-[500px] flex-col border-l border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-[#0d1216]"
          >
            {/* Header */}
            <div className="flex items-center justify-between gap-4 border-b border-zinc-200 px-6 py-4 dark:border-zinc-800/90">
              <div className="flex flex-col gap-0.5">
                <h2
                  id="provider-drawer-title"
                  className="text-base font-semibold text-zinc-900 dark:text-zinc-100"
                >
                  {isEdit
                    ? `配置供应商 · ${editingProvider?.name ?? ""}`
                    : "添加供应商"}
                </h2>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  {isEdit
                    ? "编辑基础连接信息、接口协议与 API Key 鉴权配置"
                    : "可一键套用常用预设，或在下方完成接口与密钥配置"}
                </p>
              </div>

              <button
                type="button"
                onClick={onClose}
                aria-label="关闭供应商配置抽屉"
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-zinc-200 text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500 dark:border-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Restored Draft Notice (Create mode only) */}
            {!isEdit && savedDraft ? (
              <div className="flex items-center justify-between gap-3 border-b border-amber-500/20 bg-amber-500/8 px-6 py-2.5 text-xs">
                <span className="text-amber-700 dark:text-amber-300">
                  已恢复草稿
                  {savedDraft.updatedAt ? ` · 保存于 ${savedDraft.updatedAt}` : ""}
                </span>
                <button
                  type="button"
                  onClick={handleResetToEmpty}
                  className="inline-flex items-center gap-1 font-medium text-zinc-600 whitespace-nowrap hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
                >
                  <RotateCcw className="h-3 w-3" />
                  <span>清空重置</span>
                </button>
              </div>
            ) : null}

            {/* Form Body */}
            <form
              id="provider-drawer-form"
              onSubmit={handleSubmit}
              className="flex flex-1 flex-col gap-5 overflow-y-auto px-6 py-5"
            >
              {validationError ? (
                <div
                  role="alert"
                  className="flex items-center gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3.5 py-2.5 text-xs font-medium text-rose-700 dark:text-rose-300"
                >
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  <span>{validationError}</span>
                </div>
              ) : null}

              {/* Quick Presets (Create mode only) */}
              {!isEdit ? (
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-1.5 text-[11px] font-medium text-zinc-500 dark:text-zinc-400">
                    <Sparkles className="h-3 w-3 text-emerald-500" />
                    <span>快速预设</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {PROVIDER_PRESETS.map((preset) => {
                      const active =
                        form.name.trim().toLowerCase() === preset.name &&
                        form.baseUrl.trim() === preset.baseUrl;
                      return (
                        <button
                          key={preset.id}
                          type="button"
                          onClick={() => handleApplyPreset(preset)}
                          className={`inline-flex h-7 items-center rounded-md border px-2.5 text-xs font-medium transition-colors ${
                            active
                              ? "border-emerald-500/60 bg-emerald-500/12 text-emerald-700 dark:border-emerald-500/50 dark:bg-emerald-500/15 dark:text-emerald-300"
                              : "border-zinc-200 bg-zinc-50 text-zinc-600 hover:border-zinc-300 hover:text-zinc-900 dark:border-zinc-800 dark:bg-[#090d10] dark:text-zinc-400 dark:hover:border-zinc-700 dark:hover:text-zinc-200"
                          }`}
                        >
                          {preset.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : null}

              {/* Group 1: Endpoint & Protocol */}
              <div className="flex flex-col gap-4">
                <h3 className="text-xs font-semibold text-zinc-800 dark:text-zinc-200">
                  基础与接口配置
                </h3>

                <div className="flex flex-col gap-1.5">
                  <label
                    htmlFor="drawer-provider-name"
                    className="text-xs font-medium text-zinc-600 dark:text-zinc-400"
                  >
                    供应商名称（Slug 标识） <span className="text-rose-500">*</span>
                  </label>
                  <input
                    id="drawer-provider-name"
                    type="text"
                    value={form.name}
                    onChange={(e) => handleNameChange(e.target.value)}
                    placeholder="例如 deepseek、openrouter"
                    autoFocus
                    className="h-9 w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 font-mono text-xs text-zinc-900 placeholder:text-zinc-400 focus:border-emerald-500 focus:outline-none dark:border-zinc-800 dark:bg-[#090d10] dark:text-zinc-100 dark:placeholder:text-zinc-600"
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
                    接口协议
                  </span>
                  <ConsoleSelect
                    value={form.protocol}
                    onValueChange={(next) =>
                      setForm((prev) => ({
                        ...prev,
                        protocol: next,
                      }))
                    }
                    options={API_OPTIONS.map((opt) => ({
                      value: opt.value,
                      label: opt.label,
                    }))}
                    triggerClassName="bg-zinc-50 border-zinc-200 dark:border-zinc-800 dark:bg-[#090d10]"
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <label
                    htmlFor="drawer-provider-baseurl"
                    className="text-xs font-medium text-zinc-600 dark:text-zinc-400"
                  >
                    Base URL <span className="text-rose-500">*</span>
                  </label>
                  <input
                    id="drawer-provider-baseurl"
                    type="text"
                    value={form.baseUrl}
                    onChange={(e) => {
                      setValidationError(null);
                      setForm((prev) => ({ ...prev, baseUrl: e.target.value }));
                    }}
                    placeholder={defaultBaseUrlHint(form.protocol)}
                    className="h-9 w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 font-mono text-xs text-zinc-900 placeholder:text-zinc-400 focus:border-emerald-500 focus:outline-none dark:border-zinc-800 dark:bg-[#090d10] dark:text-zinc-100 dark:placeholder:text-zinc-600"
                  />
                </div>
              </div>

              <div className="border-t border-zinc-200/80 dark:border-zinc-800/80" />

              {/* Group 2: API Key Configuration in the same interface */}
              <div className="flex flex-col gap-4">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="inline-flex items-center gap-1.5 text-xs font-semibold text-zinc-800 dark:text-zinc-200">
                    <KeyRound className="h-3.5 w-3.5 text-emerald-500" />
                    <span>API Key 鉴权配置</span>
                  </h3>
                  <span className="text-[11px] text-zinc-500 dark:text-zinc-400">
                    同屏直配，无需跳转「密钥与自检」
                  </span>
                </div>

                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <label
                      htmlFor="drawer-api-key-value"
                      className="text-xs font-medium text-zinc-600 dark:text-zinc-400"
                    >
                      API Key 密钥值
                    </label>
                    {configuredSecretState?.configured ? (
                      <span className="font-mono text-[11px] text-emerald-600 dark:text-emerald-400">
                        已配置 ({configuredSecretState.masked})
                      </span>
                    ) : null}
                  </div>
                  <div className="relative">
                    <input
                      id="drawer-api-key-value"
                      type={showApiKey ? "text" : "password"}
                      value={form.apiKeyValue}
                      onChange={(e) =>
                        setForm((prev) => ({
                          ...prev,
                          apiKeyValue: e.target.value,
                        }))
                      }
                      placeholder={
                        configuredSecretState?.configured
                          ? "已配置密钥，留空保持不变或输入新密钥覆盖"
                          : isEdit
                            ? "输入或更新 sk-... 密钥值"
                            : "输入 sk-...（支持先存草稿稍后补填）"
                      }
                      autoComplete="off"
                      className="h-9 w-full rounded-lg border border-zinc-200 bg-zinc-50 pr-10 pl-3 font-mono text-xs text-zinc-900 placeholder:text-zinc-400 focus:border-emerald-500 focus:outline-none dark:border-zinc-800 dark:bg-[#090d10] dark:text-zinc-100 dark:placeholder:text-zinc-600"
                    />
                    <button
                      type="button"
                      onClick={() => setShowApiKey((prev) => !prev)}
                      aria-label={showApiKey ? "隐藏 API Key" : "显示 API Key"}
                      className="absolute top-1/2 right-2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
                    >
                      {showApiKey ? (
                        <EyeOff className="h-3.5 w-3.5" />
                      ) : (
                        <Eye className="h-3.5 w-3.5" />
                      )}
                    </button>
                  </div>
                </div>

                <div className="flex flex-col gap-1.5">
                  <label
                    htmlFor="drawer-api-key-env"
                    className="text-xs font-medium text-zinc-600 dark:text-zinc-400"
                  >
                    映射密钥变量名
                  </label>
                  <input
                    id="drawer-api-key-env"
                    type="text"
                    value={form.apiKeyEnv}
                    onChange={(e) => {
                      setEnvManuallyEdited(true);
                      setForm((prev) => ({
                        ...prev,
                        apiKeyEnv: e.target.value,
                      }));
                    }}
                    placeholder="例如 DEEPSEEK_API_KEY"
                    className="h-9 w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 font-mono text-xs text-zinc-900 placeholder:text-zinc-400 focus:border-emerald-500 focus:outline-none dark:border-zinc-800 dark:bg-[#090d10] dark:text-zinc-100 dark:placeholder:text-zinc-600"
                  />
                  <p className="text-[11px] text-zinc-500 dark:text-zinc-500">
                    作为运行时环境变量键名使用，可随供应商名称自动推导
                  </p>
                </div>
              </div>

              {/* Group 3: Optional Provider Advanced Options */}
              <div className="border-t border-zinc-200/80 pt-3 dark:border-zinc-800/80">
                <button
                  type="button"
                  onClick={() => setShowAdvanced((prev) => !prev)}
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-zinc-600 transition-colors hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
                >
                  {showAdvanced ? (
                    <ChevronDown className="h-3.5 w-3.5" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5" />
                  )}
                  <span>高级选项（显示别名 / 缓存 TTL / 默认请求头）</span>
                </button>

                {showAdvanced ? (
                  <div className="mt-3 grid grid-cols-1 gap-3 rounded-lg border border-zinc-200/80 bg-zinc-50/70 p-3.5 sm:grid-cols-2 dark:border-zinc-800/80 dark:bg-[#090d10]/70">
                    <div className="flex flex-col gap-1.5">
                      <label
                        htmlFor="drawer-provider-display-name"
                        className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400"
                      >
                        显示别名（可选）
                      </label>
                      <input
                        id="drawer-provider-display-name"
                        type="text"
                        value={form.displayName}
                        onChange={(e) =>
                          setForm((prev) => ({
                            ...prev,
                            displayName: e.target.value,
                          }))
                        }
                        placeholder="例如 DeepSeek 官方"
                        className="h-8 w-full rounded-md border border-zinc-200 bg-white px-2.5 text-xs text-zinc-900 placeholder:text-zinc-400 focus:border-emerald-500 focus:outline-none dark:border-zinc-800 dark:bg-[#0f1418] dark:text-zinc-100 dark:placeholder:text-zinc-600"
                      />
                    </div>

                    <div className="flex flex-col gap-1.5">
                      <label
                        htmlFor="drawer-provider-ttl"
                        className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400"
                      >
                        Prompt 缓存 TTL（分钟）
                      </label>
                      <input
                        id="drawer-provider-ttl"
                        type="text"
                        inputMode="numeric"
                        value={form.cacheTtlMinutes}
                        onChange={(e) => {
                          setValidationError(null);
                          setForm((prev) => ({
                            ...prev,
                            cacheTtlMinutes: e.target.value,
                          }));
                        }}
                        placeholder="留空使用协议默认值"
                        className="h-8 w-full rounded-md border border-zinc-200 bg-white px-2.5 font-mono text-xs text-zinc-900 placeholder:text-zinc-400 focus:border-emerald-500 focus:outline-none dark:border-zinc-800 dark:bg-[#0f1418] dark:text-zinc-100 dark:placeholder:text-zinc-600"
                      />
                    </div>

                    <div className="flex flex-col gap-1.5 sm:col-span-2">
                      <label
                        htmlFor="drawer-provider-headers"
                        className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400"
                      >
                        供应商级默认请求头（JSON）
                      </label>
                      <input
                        id="drawer-provider-headers"
                        type="text"
                        value={form.customHeaders}
                        onChange={(e) => {
                          setValidationError(null);
                          setForm((prev) => ({
                            ...prev,
                            customHeaders: e.target.value,
                          }));
                        }}
                        placeholder='{"HTTP-Referer": "https://hato.local"}'
                        className="h-8 w-full rounded-md border border-zinc-200 bg-white px-2.5 font-mono text-xs text-zinc-900 placeholder:text-zinc-400 focus:border-emerald-500 focus:outline-none dark:border-zinc-800 dark:bg-[#0f1418] dark:text-zinc-100 dark:placeholder:text-zinc-600"
                      />
                    </div>
                  </div>
                ) : null}
              </div>

              {/* Group 4: Optional Initial Model (Create mode only) */}
              {!isEdit ? (
                <>
                  <div className="border-t border-zinc-200/80 dark:border-zinc-800/80" />

                  <div className="flex flex-col gap-3.5">
                    <label className="flex cursor-pointer items-center justify-between gap-3">
                      <span className="text-xs font-semibold text-zinc-800 dark:text-zinc-200">
                        同时添加初始模型
                      </span>
                      <input
                        type="checkbox"
                        checked={form.includeInitialModel}
                        onChange={(e) =>
                          setForm((prev) => ({
                            ...prev,
                            includeInitialModel: e.target.checked,
                          }))
                        }
                        className="h-4 w-4 rounded border-zinc-300 accent-emerald-500 dark:border-zinc-700"
                      />
                    </label>

                    {form.includeInitialModel ? (
                      <div className="grid grid-cols-1 gap-3 rounded-lg border border-zinc-200/80 bg-zinc-50/70 p-3.5 sm:grid-cols-2 dark:border-zinc-800/80 dark:bg-[#090d10]/70">
                        <div className="flex flex-col gap-1.5">
                          <label
                            htmlFor="drawer-model-id"
                            className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400"
                          >
                            模型 ID <span className="text-rose-500">*</span>
                          </label>
                          <input
                            id="drawer-model-id"
                            type="text"
                            value={form.initialModelId}
                            onChange={(e) => {
                              setValidationError(null);
                              setForm((prev) => ({
                                ...prev,
                                initialModelId: e.target.value,
                              }));
                            }}
                            placeholder="例如 deepseek-chat"
                            className="h-8 w-full rounded-md border border-zinc-200 bg-white px-2.5 font-mono text-xs text-zinc-900 placeholder:text-zinc-400 focus:border-emerald-500 focus:outline-none dark:border-zinc-800 dark:bg-[#0f1418] dark:text-zinc-100 dark:placeholder:text-zinc-600"
                          />
                        </div>

                        <div className="flex flex-col gap-1.5">
                          <label
                            htmlFor="drawer-model-name"
                            className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400"
                          >
                            显示名称
                          </label>
                          <input
                            id="drawer-model-name"
                            type="text"
                            value={form.initialModelName}
                            onChange={(e) =>
                              setForm((prev) => ({
                                ...prev,
                                initialModelName: e.target.value,
                              }))
                            }
                            placeholder="例如 DeepSeek Chat"
                            className="h-8 w-full rounded-md border border-zinc-200 bg-white px-2.5 text-xs text-zinc-900 placeholder:text-zinc-400 focus:border-emerald-500 focus:outline-none dark:border-zinc-800 dark:bg-[#0f1418] dark:text-zinc-100 dark:placeholder:text-zinc-600"
                          />
                        </div>

                        <div className="flex items-center gap-2 pt-1 sm:col-span-2">
                          <button
                            type="button"
                            aria-pressed={form.initialModelVision}
                            onClick={() =>
                              setForm((prev) => ({
                                ...prev,
                                initialModelVision: !prev.initialModelVision,
                              }))
                            }
                            className={`inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md border px-3 text-xs font-medium whitespace-nowrap transition-colors ${
                              form.initialModelVision
                                ? "border-emerald-500/60 bg-emerald-500/12 text-emerald-700 dark:border-emerald-500/50 dark:bg-emerald-500/15 dark:text-emerald-300"
                                : "border-zinc-200 bg-white text-zinc-500 hover:border-zinc-300 hover:text-zinc-800 dark:border-zinc-800 dark:bg-[#0f1418] dark:text-zinc-400 dark:hover:border-zinc-700"
                            }`}
                          >
                            <Eye className="h-3.5 w-3.5 shrink-0" />
                            <span>识图</span>
                          </button>

                          <button
                            type="button"
                            aria-pressed={form.initialModelThinking}
                            onClick={() =>
                              setForm((prev) => ({
                                ...prev,
                                initialModelThinking: !prev.initialModelThinking,
                              }))
                            }
                            className={`inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md border px-3 text-xs font-medium whitespace-nowrap transition-colors ${
                              form.initialModelThinking
                                ? "border-emerald-500/60 bg-emerald-500/12 text-emerald-700 dark:border-emerald-500/50 dark:bg-emerald-500/15 dark:text-emerald-300"
                                : "border-zinc-200 bg-white text-zinc-500 hover:border-zinc-300 hover:text-zinc-800 dark:border-zinc-800 dark:bg-[#0f1418] dark:text-zinc-400 dark:hover:border-zinc-700"
                            }`}
                          >
                            <Brain className="h-3.5 w-3.5 shrink-0" />
                            <span>思考</span>
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                </>
              ) : null}
            </form>

            {/* Footer Actions */}
            <div className="flex items-center justify-between gap-3 border-t border-zinc-200 px-6 py-4 dark:border-zinc-800/90">
              <button
                type="button"
                onClick={onClose}
                className="inline-flex h-9 items-center rounded-lg px-3 text-xs font-medium text-zinc-600 whitespace-nowrap transition-colors hover:bg-zinc-100 hover:text-zinc-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
              >
                取消
              </button>

              <div className="flex items-center gap-2.5">
                {!isEdit ? (
                  <button
                    type="button"
                    onClick={handleSaveDraftClick}
                    className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-zinc-200 bg-zinc-50 px-3.5 text-xs font-medium text-zinc-700 whitespace-nowrap transition-colors hover:bg-zinc-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500 dark:border-zinc-700 dark:bg-[#131a1f] dark:text-zinc-200 dark:hover:bg-zinc-800"
                  >
                    <Bookmark className="h-3.5 w-3.5" />
                    <span>保存草稿</span>
                  </button>
                ) : null}

                <button
                  type="submit"
                  form="provider-drawer-form"
                  className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-emerald-500 px-4 text-xs font-semibold text-zinc-950 whitespace-nowrap transition-colors hover:bg-emerald-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500"
                >
                  {isEdit ? (
                    <>
                      <Check className="h-3.5 w-3.5" />
                      <span>保存基本设置</span>
                    </>
                  ) : (
                    <>
                      <Plus className="h-3.5 w-3.5" />
                      <span>创建供应商</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          </motion.aside>
        </div>
      ) : null}
    </AnimatePresence>
  );
}
