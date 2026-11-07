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

The M0-08 workspace now has `pnpm build`, `pnpm lint`, `pnpm test`, and `pnpm format:check` scripts under [ADR-0016](docs/adr/0016-implementation-language.md). Run them on the supported Node.js LTS with pnpm installed; [CI](.github/workflows/ci.yml) validates the scaffold. Existing tests are **smoke checks only**—they do not prove Agentropy's domain contracts or resilience. Pull requests must also satisfy the [DCO workflow](.github/workflows/dco.yml). The future todo-skills backlog lint becomes mandatory only after the legacy roadmap has been migrated and the skill is installed.

## Backlog workflow

[TODO.md](TODO.md) is the live task tree (the [todo-skills](https://github.com/bassemZohdy/todo-skills) format, checked by `.todo/todo-lint.sh`) and [CHANGELOG.md](CHANGELOG.md) records verified roots. Do not rewrite the task structure or mark unimplemented work complete as part of an unrelated contribution; a task is done when its `Done when:` command passes.

## Review and releases

Maintainers review functionality, security, DCO, licensing and compatibility. Publishing is not decided yet ([release packaging](docs/release.md#owner-decisions)); no release is implied by the architecture decisions. Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md), not in public issues.
