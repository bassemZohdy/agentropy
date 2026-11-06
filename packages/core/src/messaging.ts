/**
 * Messaging, inbox and human-action types (docs/messaging-contract.md, docs/human-actions.md, Agent v1).
 * Types only; the runtime package implements publication, projection and decisions.
 */
import type {
  AgentInstanceId,
  JsonSchema,
  TaskId,
  TaskSnapshot,
} from './agent.js';

export const TRANSITION_EVENT_TYPES = [
  'taskAccepted',
  'taskAssigned',
  'taskStarted',
  'taskWaiting',
  'taskCompleted',
  'taskFailed',
  'taskCancelled',
] as const;

export const NON_TRANSITION_EVENT_TYPES = [
  'taskCancelRequested',
  'agentProgressUpdated',
  'notificationCreated',
  'humanActionRequested',
  'humanActionResolved',
] as const;

export type TaskEventType =
  | (typeof TRANSITION_EVENT_TYPES)[number]
  | (typeof NON_TRANSITION_EVENT_TYPES)[number];

/** Transition event type for the status a task enters. */
export const TRANSITION_EVENT: Record<TaskSnapshot['status'], TaskEventType> = {
  created: 'taskAccepted',
  assigned: 'taskAssigned',
  running: 'taskStarted',
  waiting: 'taskWaiting',
  completed: 'taskCompleted',
  failed: 'taskFailed',
  cancelled: 'taskCancelled',
};

export interface TaskEvent {
  eventId: string;
  taskId: TaskId;
  /** Task revision current when the event was committed. */
  revision: number;
  /** 0 for the transition event itself, 1.. for later non-transition events at that revision. */
  sequence: number;
  type: TaskEventType;
  status: TaskSnapshot['status'];
  occurredAt: string;
  data?: unknown;
}

/** True when `e` is strictly after the last seen `(revision, sequence)` pair. */
export function isAfter(
  e: { revision: number; sequence: number },
  last: { revision: number; sequence: number } | undefined,
): boolean {
  return (
    !last ||
    e.revision > last.revision ||
    (e.revision === last.revision && e.sequence > last.sequence)
  );
}

export type Severity = 'critical' | 'high' | 'normal' | 'low';

export interface InboxEntry {
  entryId: string;
  userId: string;
  tenantId: string;
  source: {
    eventId: string;
    taskId: TaskId;
    type:
      | 'notificationCreated'
      | 'humanActionRequested'
      | 'taskCompleted'
      | 'taskFailed';
  };
  agentInstanceId: AgentInstanceId;
  severity: Severity;
  title: string;
  body?: string;
  actionRequestId?: string;
  /** Bumps when the underlying item changes (e.g. a request is resolved or a deduplicated notification is revised). */
  revision: number;
  markers: {
    deliveredAt?: string;
    presentedAt?: string;
    presentedRevision?: number;
    readAt?: string;
    acknowledgedAt?: string;
    resolvedAt?: string;
  };
}

export type InboxMarker = 'presented' | 'read' | 'acknowledged';

export interface NotifyInput {
  severity: Severity;
  title: string;
  body: string;
  /** Same key from the same task owner revises one entry instead of creating another. */
  dedupeKey?: string;
}

export interface ConversationTurn {
  /** The user's conversational agent instance. */
  instanceId: AgentInstanceId;
  sessionId: string;
  text: string;
  idempotencyKey: string;
  /** Generated if absent. */
  correlationId?: string;
}

export type HumanActionKind = 'approval' | 'choice' | 'text' | 'form';

export interface HumanActionInput {
  kind: HumanActionKind;
  /** Rendered by the platform, never trusted as instructions. */
  prompt: string;
  inputSchema: JsonSchema;
  assignees: { principalIds?: string[]; roles?: string[] };
  dueAt?: string;
  onExpiry: 'resume' | 'fail-task';
  /**
   * Approvals only (FEAT-028.5): distinct eligible principals who must submit the same decision input before the
   * request resolves (default 1, at most 5). Differing decisions are recorded and the request stays open.
   */
  requiredApprovals?: number;
  /** Approvals only: whether the principal who delegated the task may approve it (default false). */
  allowSelfApproval?: boolean;
}

export interface HumanActionRequest extends HumanActionInput {
  requestId: string;
  taskId: TaskId;
  agentInstanceId: AgentInstanceId;
  tenantId: string;
  requestedBy: string;
  status: 'pending' | 'claimed' | 'resolved' | 'expired' | 'revoked';
  claimedBy?: string;
  claimExpiresAt?: string;
  revision: number;
}

export interface HumanDecision {
  requestId: string;
  /** The revision the user saw; mismatch → StaleRevision. */
  expectedRevision: number;
  /** Validated against the request's inputSchema. */
  input: unknown;
  idempotencyKey: string;
}
