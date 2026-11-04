# Contributing to Agentropy

Agentropy is an early **architecture/documentation project**. The framework is not yet implemented and public APIs are not stable. Please coordinate significant changes through a design issue before adding runtime code.

## License and DCO

Agentropy is licensed under the [Apache License 2.0](LICENSE). Contributions are accepted under the same license. Every contributed commit must include a Developer Certificate of Origin 1.1 sign-off line:

```text
Signed-off-by: Your Name <you@example.com>
```

Use `git commit -s` to add this line. Use your genuine name and a contact address you control. A sign-off records the contributor's certification; it is not an authorization token or a substitute for code review.

DCO text and explanation: https://developercertificate.org/

## Before opening a pull request

- Review [requirements](docs/requirements.md), [architecture](docs/architecture.md), [ADRs](docs/adr/README.md) and the [execution plan](docs/plans/PROJECT.md).
- Keep different projects independent; Agentropy does not import unrelated workflow engines or other demonstration applications as core dependencies.
- A runtime/capability/communication change requires a corresponding specification revision, clear failure semantics, tenant/authorization analysis and conformance tests.
- Mandatory audit, task durability and isolation policies cannot be bypassed for convenience.
- Avoid committing secrets, credentials, user content or production data.

## Test and formatting policy

The implementation/tooling choice is [ADR-0016](docs/adr/0016-implementation-language.md). Concrete test commands and the formatter are **not available yet** because M0-08 scaffold is outstanding. Do not claim that tests passed or invent a `pnpm test` target until it is present in package scripts and CI. Once established, every PR must pass targeted verification, the full regression suite and the todo-skills backlog lint as applicable.

## Backlog workflow

[TODO.md](TODO.md) is still the authoritative legacy roadmap. A [todo-skills migration](docs/plans/TODO-SKILLS-MIGRATION.md) is staged but not yet activated. Do not rewrite the TODO task structure or mark unimplemented work complete as part of an unrelated contribution.

## Review and releases

Maintainers review functionality, security, DCO, licensing and compatibility. The first publication/release process will be specified after the walking-skeleton milestone; no release is implied by the architecture decisions.
