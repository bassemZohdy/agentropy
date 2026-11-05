/** Lifecycle transition tables as data (docs/runtime-contract.md is authoritative). */
import { AgentropyError } from './errors.js';

export type TaskStatus =
  | 'created'
  | 'assigned'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'cancelled';
export type ExecutionState =
  | 'queued'
  | 'leased'
  | 'running'
  | 'succeeded'
  | 'yielded'
  | 'failed'
  | 'aborted'
  | 'lost';
export type InstanceState = 'available' | 'suspended' | 'retired';
export type HumanActionState =
  'pending' | 'claimed' | 'resolved' | 'expired' | 'revoked';

export interface Transition<S extends string> {
  /** Edge ID from the contract table (e.g. "T4", "E7b"); instance and human-action edges use descriptive IDs. */
  id: string;
  /** `null` is the creation edge. */
  from: S | null;
  to: S;
  trigger: string;
}

export interface StateMachine<S extends string> {
  name: 'task' | 'execution' | 'instance' | 'human-action';
  states: readonly S[];
  terminal: readonly S[];
  transitions: readonly Transition<S>[];
}

const expand = <S extends string>(
  id: string,
  from: (S | null)[],
  to: S,
  trigger: string,
): Transition<S>[] => from.map((f) => ({ id, from: f, to, trigger }));

export const TASK_MACHINE: StateMachine<TaskStatus> = {
  name: 'task',
  states: [
    'created',
    'assigned',
    'running',
    'waiting',
    'completed',
    'failed',
    'cancelled',
  ],
  terminal: ['completed', 'failed', 'cancelled'],
  transitions: [
    ...expand<TaskStatus>('T1', [null], 'created', 'delegate accepted'),
    ...expand<TaskStatus>('T2', ['created'], 'assigned', 'instance bound'),
    ...expand<TaskStatus>('T3', ['assigned'], 'running', 'execution leased'),
    ...expand<TaskStatus>(
      'T4',
      ['running'],
      'waiting',
      'handler returned waiting',
    ),
    ...expand<TaskStatus>('T5', ['waiting'], 'assigned', 'wake-up fired'),
    ...expand<TaskStatus>(
      'T6',
      ['running'],
      'assigned',
      'retryable attempt failure or lease lost',
    ),
    ...expand<TaskStatus>(
      'T7',
      ['running'],
      'completed',
      'handler returned completed',
    ),
    ...expand<TaskStatus>(
      'T8',
      ['running'],
      'failed',
      'non-retryable failure, attempts exhausted, invalid output or IncompatibleVersion',
    ),
    ...expand<TaskStatus>(
      'T9',
      ['created', 'assigned', 'waiting'],
      'failed',
      'deadline, wake-up timeout with fail, or expired human action',
    ),
    ...expand<TaskStatus>(
      'T10',
      ['created', 'assigned', 'waiting'],
      'cancelled',
      'cancel or forced retire',
    ),
    ...expand<TaskStatus>(
      'T11',
      ['running'],
      'cancelled',
      'cancel after execution end or grace period',
    ),
  ],
};

export const EXECUTION_MACHINE: StateMachine<ExecutionState> = {
  name: 'execution',
  states: [
    'queued',
    'leased',
    'running',
    'succeeded',
    'yielded',
    'failed',
    'aborted',
    'lost',
  ],
  terminal: ['succeeded', 'yielded', 'failed', 'aborted', 'lost'],
  transitions: [
    ...expand<ExecutionState>('E1', [null], 'queued', 'task T2/T5/T6'),
    ...expand<ExecutionState>('E2', ['queued'], 'leased', 'pool grant'),
    ...expand<ExecutionState>('E3', ['leased'], 'running', 'handler invoked'),
    ...expand<ExecutionState>(
      'E4',
      ['running'],
      'succeeded',
      'disposition completed',
    ),
    ...expand<ExecutionState>(
      'E5',
      ['running'],
      'yielded',
      'disposition waiting',
    ),
    ...expand<ExecutionState>(
      'E6',
      ['running'],
      'failed',
      'disposition failed or handler threw',
    ),
    ...expand<ExecutionState>(
      'E7',
      ['queued', 'leased'],
      'aborted',
      'task left a runnable state before start',
    ),
    ...expand<ExecutionState>(
      'E7b',
      ['running'],
      'aborted',
      'cancel observed by handler',
    ),
    ...expand<ExecutionState>(
      'E8',
      ['leased', 'running'],
      'lost',
      'lease expired, crash or grace period expired',
    ),
  ],
};

export const INSTANCE_MACHINE: StateMachine<InstanceState> = {
  name: 'instance',
  states: ['available', 'suspended', 'retired'],
  terminal: ['retired'],
  transitions: [
    ...expand<InstanceState>(
      'I-create',
      [null],
      'available',
      'instance created',
    ),
    ...expand<InstanceState>(
      'I-suspend',
      ['available'],
      'suspended',
      'operator/owner suspend',
    ),
    ...expand<InstanceState>('I-resume', ['suspended'], 'available', 'resume'),
    ...expand<InstanceState>(
      'I-retire',
      ['available', 'suspended'],
      'retired',
      'retire',
    ),
  ],
};

export const HUMAN_ACTION_MACHINE: StateMachine<HumanActionState> = {
  name: 'human-action',
  states: ['pending', 'claimed', 'resolved', 'expired', 'revoked'],
  terminal: ['resolved', 'expired', 'revoked'],
  transitions: [
    ...expand<HumanActionState>(
      'H-create',
      [null],
      'pending',
      'request created',
    ),
    ...expand<HumanActionState>('H-claim', ['pending'], 'claimed', 'claim'),
    ...expand<HumanActionState>(
      'H-release',
      ['claimed'],
      'pending',
      'claim released or expired',
    ),
    ...expand<HumanActionState>(
      'H-resolve',
      ['pending', 'claimed'],
      'resolved',
      'decision accepted',
    ),
    ...expand<HumanActionState>(
      'H-expire',
      ['pending', 'claimed'],
      'expired',
      'due time passed',
    ),
    ...expand<HumanActionState>(
      'H-revoke',
      ['pending', 'claimed'],
      'revoked',
      'request revoked',
    ),
  ],
};

export function findTransition<S extends string>(
  machine: StateMachine<S>,
  from: S | null,
  to: S,
): Transition<S> | undefined {
  return machine.transitions.find((t) => t.from === from && t.to === to);
}

/** Returns the edge or throws InvalidState for any edge not listed in the contract table. */
export function assertTransition<S extends string>(
  machine: StateMachine<S>,
  from: S | null,
  to: S,
  edgeId?: string,
): Transition<S> {
  const edge = machine.transitions.find(
    (t) =>
      t.from === from &&
      t.to === to &&
      (edgeId === undefined || t.id === edgeId),
  );
  if (!edge) {
    throw new AgentropyError(
      'InvalidState',
      `Illegal ${machine.name} transition ${from ?? '∅'} → ${to}`,
      {
        details: {
          machine: machine.name,
          from: from ?? 'none',
          to,
          ...(edgeId ? { edge: edgeId } : {}),
        },
      },
    );
  }
  return edge;
}

export function isTerminal<S extends string>(
  machine: StateMachine<S>,
  state: S,
): boolean {
  return machine.terminal.includes(state);
}
