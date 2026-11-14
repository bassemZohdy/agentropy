/**
 * Lifecycle status of tools and skills kept in the store (FEAT-074; Tool v1 revision 6, Skill v1). The registries hold
 * descriptors and files that the application registers at every start; what must outlive a process and reach every
 * worker is the status an operator set: `active`, `suspended`, `revoked`. It is one row per tool or skill version in the
 * `lifecycle` collection. A row is only ever tightened by a restart: `register` adopts it, and `revoked` is final.
 */
import {
  AgentropyError,
  type Store,
  type StoreTx,
  type VersionedRef,
} from '@agentropy/core';

export type LifecycleStatus = 'registered' | 'active' | 'suspended' | 'revoked';
export type LifecycleKind = 'tool' | 'skill';

export interface LifecycleRow {
  kind: LifecycleKind;
  id: string;
  version: string;
  status: LifecycleStatus;
  /** Content digest of what the status was set for: a row never applies to different content. */
  digest?: string;
  by?: string;
  at?: string;
}

export const lifecycleKey = (kind: LifecycleKind, ref: VersionedRef): string =>
  `${kind}:${ref.id}@${ref.version}`;

/** The status row of one version, if an operator ever set one. */
export const readLifecycle = (
  store: Store,
  kind: LifecycleKind,
  ref: VersionedRef,
) =>
  store.transaction((tx) =>
    tx.get<LifecycleRow>('lifecycle', lifecycleKey(kind, ref)),
  );

/** Every status row of one kind, by version key. */
export async function readLifecycles(
  store: Store,
  kind: LifecycleKind,
): Promise<Map<string, LifecycleRow>> {
  const rows = await store.transaction((tx) =>
    tx.find<LifecycleRow>('lifecycle', { where: { kind } }),
  );
  return new Map(rows.map((r) => [lifecycleKey(kind, r.value), r.value]));
}

/**
 * The status to act on: the stored row when it applies to this content, else what this process knows. An `active` row
 * does not make unverified content usable, and a row for other content (a digest that differs) is not adopted: only
 * a stricter status is ever taken from a row that cannot be tied to the content.
 */
export function effectiveStatus(
  local: LifecycleStatus,
  row: LifecycleRow | undefined,
  digest: string,
  verified: boolean,
): LifecycleStatus {
  if (!row) return local;
  const sameContent = row.digest === digest;
  if (row.status === 'active')
    return sameContent && verified ? 'active' : local;
  return row.status;
}

/** A row that names other content than the one being registered: the version is already taken. */
export function conflicts(row: LifecycleRow | undefined, digest: string) {
  return row?.digest !== undefined && row.digest !== digest;
}

/**
 * Moves the stored status in one transaction: it re-reads the row, refuses a move the current status does not allow
 * (`revoked` is final) and writes the new one, so two workers cannot undo each other's operator action.
 */
export async function moveLifecycle(
  store: Store,
  kind: LifecycleKind,
  ref: VersionedRef,
  change: {
    from: LifecycleStatus[];
    to: LifecycleStatus;
    /** The status this process knows, when no row exists yet. */
    local: LifecycleStatus;
    digest: string;
    by: string;
    at: string;
  },
): Promise<void> {
  await store.transaction(async (tx: StoreTx) => {
    const cur = await tx.get<LifecycleRow>(
      'lifecycle',
      lifecycleKey(kind, ref),
    );
    const status = cur?.value.status ?? change.local;
    if (!change.from.includes(status))
      throw new AgentropyError(
        'InvalidState',
        `Cannot move a ${status} ${kind}`,
        { details: { status } },
      );
    const value: LifecycleRow = {
      kind,
      id: ref.id,
      version: ref.version,
      status: change.to,
      digest: change.digest,
      by: change.by,
      at: change.at,
    };
    if (cur) await tx.update('lifecycle', cur.id, cur.revision, value);
    else await tx.insert('lifecycle', lifecycleKey(kind, ref), value);
  });
}
