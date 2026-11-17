import { RotateCcw, Save } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "@/api";
import { ConsolePageHeader } from "@/components/console/ConsolePrimitives";
import { Button, StatefulButton, type ButtonState } from "@/components/motion/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/motion/card";

export interface PromptPanelProps {
  promptPath: string;
  initialPrompt: string;
  onSaved: (nextPrompt: string, changes?: string[]) => void;
  onToast: (input: { title: string; description?: string; status?: "info" | "success" | "error" }) => void;
}

export function PromptPanel({
  promptPath,
  initialPrompt,
  onSaved,
  onToast,
}: PromptPanelProps) {
  const [text, setText] = useState(initialPrompt);
  const [saveState, setSaveState] = useState<ButtonState>("idle");

  useEffect(() => {
    setText(initialPrompt);
  }, [initialPrompt]);

  const dirty = text !== initialPrompt;
  const lineCount = text ? text.split("\n").length : 0;

  const handleSave = async () => {
    setSaveState("loading");
    try {
      const res = await api.savePrompt(text);
      setSaveState("success");
      onSaved(text, res.changes);
      onToast({
        title: "人设提示词已保存",
        description: res.changes?.length ? res.changes.join("；") : undefined,
        status: "success",
      });
      setTimeout(() => setSaveState("idle"), 1600);
    } catch (err) {
      setSaveState("error");
      onToast({
        title: "保存提示词失败",
        description: err instanceof Error ? err.message : String(err),
        status: "error",
      });
      setTimeout(() => setSaveState("idle"), 2000);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <ConsolePageHeader
        title="人设提示词"
        actions={
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!dirty}
              onClick={() => setText(initialPrompt)}
            >
              <RotateCcw className="size-3.5" />
              还原修改
            </Button>
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
              保存提示词
            </StatefulButton>
          </>
        }
      />

      <Card size="compact" className="flex min-h-0 flex-1 flex-col">
        <CardHeader>
          <CardTitle className="font-mono text-sm">{promptPath}</CardTitle>
          <CardDescription className="tabular-nums text-xs">
            {text.length} 字符 · {lineCount} 行 · {dirty ? "尚未保存" : "已保存"}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex min-h-0 flex-1 flex-col">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
            aria-label="人设提示词编辑器"
            className="min-h-[380px] w-full flex-1 resize-y rounded-xl border border-border bg-muted/20 p-4 font-mono text-[13px] leading-relaxed text-foreground outline-none focus:border-ring focus:ring-2 focus:ring-ring/20"
          />
        </CardContent>
      </Card>
    </div>
  );
}
