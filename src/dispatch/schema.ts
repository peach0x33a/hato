import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export const WORKER_BACKENDS = [
  "codex-cli",
  "antigravity-cli",
  "opencode-v2",
  "external-pi",
  "claude-code",
  "builtin-pi",
] as const;

export const WorkerBackendSchema = Type.Union([
  Type.Literal("codex-cli"),
  Type.Literal("antigravity-cli"),
  Type.Literal("opencode-v2"),
  Type.Literal("external-pi"),
  Type.Literal("claude-code"),
  Type.Literal("builtin-pi"),
]);
export type WorkerBackend = Static<typeof WorkerBackendSchema>;

export const TicketStatusSchema = Type.Union([
  Type.Literal("routing"),
  Type.Literal("pending"),
  Type.Literal("running"),
  Type.Literal("needs_input"),
  Type.Literal("awaiting_confirm"),
  Type.Literal("done"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
]);
export type TicketStatus = Static<typeof TicketStatusSchema>;

export const MandateSchema = Type.Object({
  workspace_mode: Type.Union([Type.Literal("isolated"), Type.Literal("host_repo")]),
  workspace_dir: Type.String({ minLength: 1 }),
  is_host_repo: Type.Boolean(),
  network: Type.Union([Type.Literal("none"), Type.Literal("egress")]),
  timeout_ms: Type.Number({ minimum: 1000 }),
  skills: Type.Array(Type.String()),
  allowed_mcp_servers: Type.Array(Type.String()),
  confirm_before: Type.Array(Type.String()),
  deliver_files: Type.Optional(Type.Boolean()),
  execution_mode: Type.Optional(
    Type.Union([Type.Literal("isolated"), Type.Literal("vm_unrestricted")]),
  ),
});
export type WorkerMandate = Static<typeof MandateSchema>;

export const VerbatimBlockSchema = Type.Object({
  title: Type.String({ minLength: 1 }),
  format: Type.Union([Type.Literal("code"), Type.Literal("text"), Type.Literal("markdown")]),
  content: Type.String(),
});
export type VerbatimBlock = Static<typeof VerbatimBlockSchema>;

export const ResultArtifactSchema = Type.Object({
  path: Type.String({ minLength: 1 }),
  filename: Type.String({ minLength: 1 }),
  send_as: Type.Union([Type.Literal("file"), Type.Literal("photo")]),
});
export type ResultArtifact = Static<typeof ResultArtifactSchema>;

export const WorkerResultSchema = Type.Object({
  ticket_id: Type.String({ minLength: 1 }),
  status: Type.Union([
    Type.Literal("done"),
    Type.Literal("needs_input"),
    Type.Literal("awaiting_confirm"),
    Type.Literal("failed"),
  ]),
  narration_hint: Type.String(),
  verbatim_blocks: Type.Array(VerbatimBlockSchema),
  artifacts: Type.Array(ResultArtifactSchema),
  required_secrets: Type.Array(Type.String()),
  caveats: Type.Array(Type.String()),
  question: Type.Optional(Type.String()),
  confirm_action: Type.Optional(Type.String()),
});
export type WorkerResult = Static<typeof WorkerResultSchema>;

export const RouterScheduleOpDecisionSchema = Type.Object({
  decision: Type.Literal("schedule_op"),
  action: Type.Union([
    Type.Literal("reschedule"),
    Type.Literal("pause"),
    Type.Literal("resume"),
    Type.Literal("delete"),
  ]),
  target_type: Type.Union([Type.Literal("script"), Type.Literal("open_loop")]),
  target_id: Type.String({ minLength: 1 }),
  cron_expr: Type.Optional(Type.String()),
  summary: Type.String({ minLength: 1 }),
});

export const RouterTicketDecisionSchema = Type.Object({
  decision: Type.Literal("ticket"),
  backend: WorkerBackendSchema,
  brief_title: Type.String({ minLength: 1 }),
  context_range: Type.Object({
    from_msg_id: Type.String({ minLength: 1 }),
    to_msg_id: Type.String({ minLength: 1 }),
  }),
  workspace_mode: Type.Optional(Type.Union([Type.Literal("isolated"), Type.Literal("host_repo")])),
  repo_path: Type.Optional(Type.String()),
  network: Type.Optional(Type.Union([Type.Literal("none"), Type.Literal("egress")])),
  skills: Type.Optional(Type.Array(Type.String())),
  allowed_mcp_servers: Type.Optional(Type.Array(Type.String())),
  confirm_before: Type.Optional(Type.Array(Type.String())),
});

export const RouterNeedsInputDecisionSchema = Type.Object({
  decision: Type.Literal("needs_input"),
  brief_title: Type.String({ minLength: 1 }),
  question: Type.String({ minLength: 1 }),
});

export const RouterDecisionSchema = Type.Union([
  RouterScheduleOpDecisionSchema,
  RouterTicketDecisionSchema,
  RouterNeedsInputDecisionSchema,
]);
export type RouterDecision = Static<typeof RouterDecisionSchema>;

export const InputClassifierDecisionSchema = Type.Object({
  route: Type.Union([Type.Literal("reply_ticket"), Type.Literal("persona_chat")]),
  ticket_id: Type.Optional(Type.String()),
  objective_reply: Type.Optional(Type.String()),
});
export type InputClassifierDecision = Static<typeof InputClassifierDecisionSchema>;

export function parseWorkerMandate(jsonStr: string | null | undefined): WorkerMandate | null {
  if (!jsonStr) return null;
  try {
    const parsed = JSON.parse(jsonStr) as unknown;
    return Value.Check(MandateSchema, parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function validateWorkerResult(raw: unknown): WorkerResult {
  if (!Value.Check(WorkerResultSchema, raw)) {
    const errors = [...Value.Errors(WorkerResultSchema, raw)]
      .slice(0, 5)
      .map((e) => `${e.path || "<root>"}: ${e.message}`)
      .join("; ");
    throw new Error(`Invalid WorkerResult: ${errors}`);
  }
  return raw;
}
