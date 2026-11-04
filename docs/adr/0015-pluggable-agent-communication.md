# ADR-0015: Pluggable agent communication with A2A preference

- Status: Accepted (architecture direction)
- Date: 2026-11-04

## Context

Agentropy must coordinate agents within a process, across services and across independent frameworks and languages. A2A provides a standard interoperability protocol, but requiring it for every in-process call would impose avoidable serialization/network overhead. Conversely, a proprietary-only internal protocol would constrain portability.

## Decision

Expose one **AgentCommunication** contract to callers, backed by independently pluggable **AgentCommunicationProvider** implementations and a **CommunicationRouter**. Initial provider categories are direct/in-process, A2A and custom adapters (including broker/RPC when needed). A2A is the **preferred standards-based protocol for independently addressable agents**; internal direct invocation is allowed as an optimization. Do not expose transport-specific APIs to agent business logic.

The abstraction covers delegation, messaging, task status/results, cancellation and event subscriptions. Provider capability descriptors state supported operations, protocol/version, delivery semantics and limitations. The router chooses only from authorized and compatible routes using target registration, topology and policy. No silent fallback to a less secure or less durable route.

## Boundaries

- Agentropy's Task Service remains authoritative for local tasks; remote A2A task states are mapped into local tracking records without claiming authority over the remote runtime.
- AgentCommunication delegates through trusted service boundaries; message principal and delegated authorization must be verified.
- Reliable acceptance, idempotency, correlation, causation and observability are shared contract requirements, but transport-level durability must be declared and tested per provider.
- A2A and custom transports are not required to expose identical optional features. Unsupported operations fail explicitly.
- Agent discovery/registry, communication/routing and execution/pooling are separate responsibilities.
- A2A is not a replacement for MCP tools or durable workflow execution.

## Consequences

Allows TypeScript, Python and other agents to collaborate without mandating one runtime. Requires adapter conformance tests and protocol version negotiation. Direct provider can be the first working implementation while A2A interoperability is a first-class release requirement.

## Alternatives

A2A for every internal call (extra overhead); native-only with late A2A integration (interoperability gap); broker as mandatory agent protocol (nonstandard semantic coupling).

## Follow-up

Define a versioned provider interface, route-selection precedence, provider metadata, error mapping, trust boundaries and A2A task/state mapping before implementation. See [communication contract](../contracts/communication-v1.md).
