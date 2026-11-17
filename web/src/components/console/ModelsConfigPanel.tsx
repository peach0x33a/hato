import { Plus, Save, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, type ModelDefinitionConfig, type ModelsFileConfig, type ProviderConfig } from "@/api";
import {
  ApiBadge,
  ConsoleInput,
  ConsolePageHeader,
  ConsoleSelect,
  SlotBadge,
} from "@/components/console/ConsolePrimitives";
import { Button, StatefulButton, type ButtonState } from "@/components/motion/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/motion/collapsible";
import { Switch } from "@/components/motion/switch";

const API_OPTIONS = [
  { value: "anthropic-messages", label: "Anthropic Messages" },
  { value: "openai-responses", label: "OpenAI Responses" },
  { value: "openai-completions", label: "OpenAI Completions" },
  { value: "google-generative-ai", label: "Google Gemini" },
  { value: "hato-faux-api", label: "Faux（本地测试）" },
];

const API_OVERRIDE_OPTIONS = [
  { value: "__inherit__", label: "继承供应商默认协议" },
  ...API_OPTIONS,
];

const SLOT_META: Array<{ key: keyof ModelsFileConfig["slots"]; label: string }> = [
  { key: "persona", label: "主对话槽位" },
  { key: "worker", label: "后台执行槽位" },
  { key: "router", label: "轻量路由槽位" },
  { key: "curator", label: "上下文整理槽位" },
  { key: "hindsight_llm", label: "记忆抽取槽位" },
];

export interface ModelsConfigPanelProps {
  initialConfig: ModelsFileConfig;
  onSaved: (next: ModelsFileConfig, changes?: string[]) => void;
  onToast: (input: { title: string; description?: string; status?: "info" | "success" | "error" }) => void;
}

export function ModelsConfigPanel({
  initialConfig,
  onSaved,
  onToast,
}: ModelsConfigPanelProps) {
  const [draft, setDraft] = useState<ModelsFileConfig>(() => structuredClone(initialConfig));
  const [saveState, setSaveState] = useState<ButtonState>("idle");
  const [newProviderSlug, setNewProviderSlug] = useState("");

  useEffect(() => {
    setDraft(structuredClone(initialConfig));
  }, [initialConfig]);

  const allTargets = useMemo(() => {
    const out: string[] = [];
    for (const [slug, prov] of Object.entries(draft.providers)) {
      for (const m of prov.models) {
        if (m.id.trim()) out.push(`${slug}/${m.id.trim()}`);
      }
    }
    return out;
  }, [draft.providers]);

  const updateProvider = (slug: string, patch: Partial<ProviderConfig>) => {
    setDraft((prev) => ({
      ...prev,
      providers: {
        ...prev.providers,
        [slug]: { ...prev.providers[slug]!, ...patch },
      },
    }));
  };

  const updateModel = (
    slug: string,
    index: number,
    patch: Partial<ModelDefinitionConfig>,
  ) => {
    setDraft((prev) => {
      const prov = prev.providers[slug]!;
      const models = prov.models.map((m, i) => (i === index ? { ...m, ...patch } : m));
      return {
        ...prev,
        providers: {
          ...prev.providers,
          [slug]: { ...prov, models },
        },
      };
    });
  };

  const addModel = (slug: string) => {
    setDraft((prev) => {
      const prov = prev.providers[slug]!;
      return {
        ...prev,
        providers: {
          ...prev.providers,
          [slug]: {
            ...prov,
            models: [
              ...prov.models,
              {
                id: "new-model",
                name: "New Model",
                reasoning: false,
                input: ["text"],
                context_window: 128000,
                max_tokens: 8192,
              },
            ],
          },
        },
      };
    });
  };

  const removeModel = (slug: string, index: number) => {
    setDraft((prev) => {
      const prov = prev.providers[slug]!;
      return {
        ...prev,
        providers: {
          ...prev.providers,
          [slug]: {
            ...prov,
            models: prov.models.filter((_, i) => i !== index),
          },
        },
      };
    });
  };

  const addProvider = () => {
    const clean = newProviderSlug
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-");
    if (!clean || draft.providers[clean]) {
      onToast({
        title: "无法添加供应商",
        description: "请填写未重复的英文名称（例如 openrouter）",
        status: "error",
      });
      return;
    }
    const envGuess = `${clean.replace(/-/g, "_").toUpperCase()}_API_KEY`;
    setDraft((prev) => ({
      ...prev,
      providers: {
        ...prev.providers,
        [clean]: {
          api: "openai-responses",
          base_url: "https://api.openai.com/v1",
          api_key_env: envGuess,
          models: [
            {
              id: "gpt-4.1-mini",
              name: "GPT-4.1 Mini",
              reasoning: false,
              input: ["text", "image"],
              context_window: 128000,
              max_tokens: 8192,
            },
          ],
        },
      },
    }));
    setNewProviderSlug("");
  };

  const removeProvider = (slug: string) => {
    setDraft((prev) => {
      const nextProviders = { ...prev.providers };
      delete nextProviders[slug];
      return { ...prev, providers: nextProviders };
    });
  };

  const handleSave = async () => {
    setSaveState("loading");
    try {
      const res = await api.saveModelsConfig(draft);
      setSaveState("success");
      onSaved(draft, res.changes);
      onToast({
        title: "模型配置已保存",
        description: res.changes?.length ? res.changes.join("；") : "配置已生效",
        status: "success",
      });
      setTimeout(() => setSaveState("idle"), 1600);
    } catch (err) {
      setSaveState("error");
      onToast({
        title: "保存模型配置失败",
        description: err instanceof Error ? err.message : String(err),
        status: "error",
      });
      setTimeout(() => setSaveState("idle"), 2000);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <ConsolePageHeader
        title="模型与供应商"
        actions={
          <StatefulButton
            type="button"
            size="sm"
            state={saveState}
            loadingText="保存中…"
            successText="已保存"
            errorText="保存失败"
            icon={<Save className="size-3.5" />}
            onClick={() => void handleSave()}
          >
            保存模型配置
          </StatefulButton>
        }
      />

      {/* Unified Slots + Providers Sheet */}
      <div className="overflow-hidden rounded-xl border border-border bg-card divide-y divide-border">
        <div className="space-y-3 p-4">
          <div className="text-xs font-semibold text-foreground">功能槽位</div>
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-5">
            {SLOT_META.map((item) => {
              const val = draft.slots[item.key];
              const options = (allTargets.includes(val) ? allTargets : [val, ...allTargets]).map(
                (target) => ({ value: target, label: target }),
              );
              return (
                <div key={item.key} className="space-y-1.5">
                  <div className="flex items-center gap-1.5">
                    <SlotBadge slot={item.key} />
                    <span className="text-[11px] text-muted-foreground">{item.label}</span>
                  </div>
                  <ConsoleSelect
                    value={val}
                    options={options}
                    onValueChange={(next) =>
                      setDraft((prev) => ({
                        ...prev,
                        slots: { ...prev.slots, [item.key]: next },
                      }))
                    }
                  />
                </div>
              );
            })}
          </div>
        </div>

        {/* Providers Section Bar */}
        <div className="flex flex-wrap items-center justify-between gap-2 bg-muted/25 px-4 py-2.5">
          <span className="text-xs font-semibold text-foreground">
            供应商与模型（{Object.keys(draft.providers).length}）
          </span>
          <div className="flex items-center gap-2">
            <div className="w-56">
              <ConsoleInput
                size="sm"
                value={newProviderSlug}
                onChange={setNewProviderSlug}
                placeholder="新增供应商名称 (如 deepseek)"
              />
            </div>
            <Button type="button" variant="outline" size="sm" onClick={addProvider}>
              <Plus className="size-3.5" />
              添加供应商
            </Button>
          </div>
        </div>

        {/* Continuous Provider Blocks separated by hairlines */}
        {Object.entries(draft.providers).map(([slug, prov]) => (
          <div key={slug} className="divide-y divide-border/70">
            <div className="flex flex-wrap items-center justify-between gap-2 bg-muted/10 px-4 py-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-sm font-semibold text-foreground">{slug}</span>
                <ApiBadge api={prov.api} />
                <span className="text-xs text-muted-foreground">
                  {prov.models.length} 个模型
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => addModel(slug)}>
                  <Plus className="size-3.5" />
                  添加模型
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => removeProvider(slug)}
                  className="text-destructive hover:text-destructive"
                >
                  <Trash2 className="size-3.5" />
                  删除供应商
                </Button>
              </div>
            </div>

            <div className="grid gap-3 px-4 py-3 md:grid-cols-3">
              <ConsoleSelect
                label="接口协议"
                value={prov.api}
                options={API_OPTIONS}
                onValueChange={(next) => updateProvider(slug, { api: next })}
              />
              <ConsoleInput
                label="Base URL"
                value={prov.base_url}
                onChange={(v) => updateProvider(slug, { base_url: v })}
                placeholder="https://api.example.com/v1"
              />
              <ConsoleInput
                label="密钥变量名"
                value={prov.api_key_env}
                onChange={(v) => updateProvider(slug, { api_key_env: v })}
                placeholder="ANTHROPIC_API_KEY"
              />
            </div>

            {prov.models.map((m, idx) => (
              <div key={`${slug}-m-${idx}`} className="bg-muted/5 px-4 py-3">
                <div className="grid items-end gap-3 md:grid-cols-12">
                  <div className="md:col-span-4">
                    <ConsoleInput
                      label="模型 ID"
                      value={m.id}
                      onChange={(v) => updateModel(slug, idx, { id: v })}
                    />
                  </div>
                  <div className="md:col-span-3">
                    <ConsoleInput
                      label="显示名称"
                      value={m.name ?? ""}
                      onChange={(v) => updateModel(slug, idx, { name: v || undefined })}
                    />
                  </div>
                  <div className="md:col-span-3 flex h-9 items-center gap-4">
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span>识图</span>
                      <Switch
                        checked={Boolean(m.input?.includes("image"))}
                        onCheckedChange={(on) =>
                          updateModel(slug, idx, { input: on ? ["text", "image"] : ["text"] })
                        }
                      />
                    </label>
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span>思考</span>
                      <Switch
                        checked={Boolean(m.reasoning)}
                        onCheckedChange={(on) => updateModel(slug, idx, { reasoning: on })}
                      />
                    </label>
                  </div>
                  <div className="md:col-span-2 flex h-9 items-center justify-end">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => removeModel(slug, idx)}
                      className="text-destructive hover:text-destructive"
                    >
                      移除模型
                    </Button>
                  </div>
                </div>

                <Collapsible className="mt-2.5">
                  <CollapsibleTrigger className="rounded-lg border border-border px-2.5 py-1 text-[11px] text-muted-foreground hover:text-foreground">
                    高级参数（上下文大小与接口覆盖）
                  </CollapsibleTrigger>
                  <CollapsibleContent className="mt-2.5 grid gap-3 pt-1 md:grid-cols-4">
                    <ConsoleInput
                      label="上下文窗口"
                      type="number"
                      value={String(m.context_window ?? 128000)}
                      onChange={(v) =>
                        updateModel(slug, idx, { context_window: Number(v) || 128000 })
                      }
                    />
                    <ConsoleInput
                      label="最大输出 Tokens"
                      type="number"
                      value={String(m.max_tokens ?? 8192)}
                      onChange={(v) =>
                        updateModel(slug, idx, { max_tokens: Number(v) || 8192 })
                      }
                    />
                    <ConsoleSelect
                      label="覆盖协议"
                      value={m.api ?? "__inherit__"}
                      options={API_OVERRIDE_OPTIONS}
                      onValueChange={(v) =>
                        updateModel(slug, idx, {
                          api: v === "__inherit__" ? undefined : v,
                        })
                      }
                    />
                    <ConsoleInput
                      label="覆盖 Base URL"
                      value={m.base_url ?? ""}
                      onChange={(v) =>
                        updateModel(slug, idx, { base_url: v.trim() || undefined })
                      }
                      placeholder={prov.base_url}
                    />
                  </CollapsibleContent>
                </Collapsible>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
