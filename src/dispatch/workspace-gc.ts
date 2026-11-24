import { existsSync, rmSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { HatoRepository } from "../db/repo.js";
import { parseWorkerMandate } from "./schema.js";

const ACTIVE_TICKET_STATUSES = new Set([
  "routing",
  "pending",
  "running",
  "needs_input",
  "awaiting_confirm",
]);

/**
 * Deletes expired isolated ticket workspace directories (`workspaceExpiresAt <= nowMs`)
 * while preserving active tickets and `host_repo` / `vm_unrestricted` directories.
 */
export function cleanupExpiredWorkspaces(params: {
  repo: HatoRepository;
  workspacesDir: string;
  nowMs?: number;
  limit?: number;
}): { removedCount: number; clearedCount: number } {
  const nowMs = params.nowMs ?? Date.now();
  const root = resolve(params.workspacesDir);
  const expired = params.repo.listExpiredWorkspaceTickets(nowMs, params.limit ?? 50);
  const registeredScripts = params.repo.listScripts(500);
  const protectedTicketIds = new Set(registeredScripts.map((s) => s.ticketId));
  const protectedPaths = registeredScripts.map((s) => resolve(s.scriptPath));

  let removedCount = 0;
  let clearedCount = 0;

  for (const ticket of expired) {
    if (ACTIVE_TICKET_STATUSES.has(ticket.status)) continue;

    const mandate = parseWorkerMandate(ticket.mandateJson);
    if (mandate?.workspace_mode === "host_repo") {
      params.repo.clearTicketWorkspaceExpiry(ticket.id);
      clearedCount++;
      continue;
    }

    const candidateDir = resolve(root, ticket.id);
    if (
      protectedTicketIds.has(ticket.id) ||
      protectedPaths.some((p) => p === candidateDir || p.startsWith(candidateDir + sep))
    ) {
      continue;
    }

    if (candidateDir !== root && candidateDir.startsWith(`${root}${sep}`) && existsSync(candidateDir)) {
      rmSync(candidateDir, { recursive: true, force: true });
      removedCount++;
    }

    params.repo.clearTicketWorkspaceExpiry(ticket.id);
    clearedCount++;
  }

  return { removedCount, clearedCount };
}
