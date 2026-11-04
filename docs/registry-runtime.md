# Agent registry, instance directory, pool and runtime

## Four separate responsibilities

**Definition Registry:** Versioned, discoverable agent definitions with profiles, capabilities, schema validation and provider requirements. Resolve by explicit ID/version or capability query, filtered through ownership and authorization.

**Instance Directory:** Tracks persistent logical agents: instance IDs, definition revisions, owner/tenant, effective configuration and lifecycle status. A logical agent can have many tasks and remain available while no worker is running.

**Execution Pool:** Allocates *physical* worker slots/leases, enforces limits and isolates concurrency. It does not own an agent's durable identity. A sleeping always-on agent must not consume a permanent slot.

**Agent Runtime:** Validates tasks and capabilities, starts/resumes/cancels executions, checkpoints state, handles durable wait/activation and ensures observable transitions. Providers may implement their own checkpoint and queue mechanics behind adapters.

## Candidate interfaces (conceptual)

```ts
interface AgentRegistry {
  resolve(id: string, version?: string): Promise<AgentDefinition>;
  discover(query: AgentQuery, authorization: AuthorizationContext): Promise<AgentDefinition[]>;
}

interface AgentInstanceDirectory {
  get(instanceId: string, authorization: AuthorizationContext): Promise<AgentInstance>;
  listByOwner(ownerId: string, authorization: AuthorizationContext): Promise<AgentInstance[]>;
}

interface AgentPool {
  acquire(request: ExecutionRequest): Promise<ExecutionLease>;
  release(leaseId: string): Promise<void>;
}

interface AgentRuntime {
  start(task: DelegatedTask): Promise<ExecutionHandle>;
  suspend(executionId: string): Promise<void>;
  resume(executionId: string): Promise<void>;
  cancel(executionId: string): Promise<void>;
}
```

Names are illustrative and referenced interfaces have not yet been implemented.

## Pool and lease safety

Acquire capacity atomically with fair tenant and priority quotas. Leases expire and are fenced by monotonically advancing epochs/versions; late workers may not overwrite newer task state. Release unused capacity when waiting for events, approvals or schedules. Separate durable task state from ephemeral worker health.

## Registry concerns

Registration validates schema, profile constraints and capability dependencies. Definition versions are immutable and allow explicit migration between compatible versions. Discovery returns candidates with supported capabilities; selection is authorized and deterministic under a fixed policy. No dynamic execution of untrusted code merely because a definition appears in the registry.

## First implementation boundary

A local registry + in-process pool + durable store + simple event/scheduler adapter is enough to prove the model. Design external/distributed registries and pools as later evolutions. Evaluate remote protocol support only once trust and capability semantics are defined.
