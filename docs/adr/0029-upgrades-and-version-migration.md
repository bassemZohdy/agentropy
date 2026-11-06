# ADR-0029: Upgrades — instance version migration, checkpoint codecs and store schema evolution

- Status: Accepted (2026-11-06)
- Resolves: D-07 and M3-03. Accepts the pinning part of [ADR-0013](0013-version-pinned-agent-executions.md) for the native runtime; replay-based engines remain under ADR-0013's open questions.

## Context

ADR-0013 proposed pinning each accepted task to immutable versions and never upgrading in-flight work silently. The runtime already pins every task to an `AcceptanceSnapshot` (Agent v1 rev 7) and fails an activation whose handler is gone with `IncompatibleVersion` (AC-10). Open points (D-07): how an instance moves to a newer definition, how rollback and retirement work, what happens when a redeployed handler reads a checkpoint written by older code, and how a store written by an older release keeps working.

## Decision

1. **Instance migration is explicit and audited.** `upgradeInstance(instanceId, { version, expectedRevision })` (owner or trusted service, policy action `agent:upgrade`) changes the definition version the instance uses for **future** tasks only. The target must be a registered version of the same definition; the call is compare-and-swap on the instance revision; retired instances are refused. The change writes an `instance.upgrade` audit intent (`from`, `to`) in the same transaction and records `previousDefinition`.
2. **Rollback is the same operation** with an earlier registered version. There is no implicit rollback and no rewrite of accepted tasks in either direction.
3. **Retirement constraint.** A definition version may be removed from a deployment only when `versionsInUse(definitionId)` (trusted services, tenant-scoped) reports zero live instances and zero non-terminal tasks for it. Removing it earlier is allowed but those tasks fail their next activation with `IncompatibleVersion` (T8); they are never moved to another version.
4. **Checkpoint codecs.** Checkpoints are stored with the codec version of the handler that wrote them (`Agent.checkpointCodec.version`, default 1). Reading an older checkpoint calls `checkpointCodec.upgrade(data, fromVersion)`; a missing or throwing upgrade, or a checkpoint newer than the handler, fails the activation with `IncompatibleVersion` (`details.kind: "checkpoint"`). This covers a patched build deployed under the same pinned artifact version.
5. **Store schema evolution is additive and automatic.** On start, each adapter creates missing collection tables and index columns and backfills new columns from the stored JSON (SQLite in one immediate transaction; PostgreSQL under the migration advisory lock). A database whose recorded schema version is newer than the adapter is refused (`IncompatibleVersion`). Non-additive changes require a numbered migration and a new ADR.

## Consequences

Operators can roll a definition forward and back per instance with an audit trail, and can see when an old version is safe to remove. Handler authors who change a checkpoint shape bump the codec version and provide `upgrade`. Downgrading code below a checkpoint's codec version is detected rather than misread. Rolling deployments with mixed versions work because pins and codecs are per task, not per worker.

## Alternatives

Upgrading in-flight tasks on deployment (violates ADR-0013); per-version worker routing for native handlers (unnecessary: the handler is looked up per activation); a migration framework with numbered down-migrations for every collection change (more machinery than additive evolution needs today).
