# ADR-0023: Project licensing and contribution policy

- Status: Accepted (2026-11-04), architecture/planning decision
- Scope: Agentropy repository; not the unrelated todo-skills project

## Decision

- Use the **Apache License, Version 2.0** for Agentropy source-code contributions.
- Use the **Developer Certificate of Origin (DCO) 1.1** sign-off process rather than a blanket contributor license assignment. Contributors certify the provenance/rights of their work by including `Signed-off-by: Full Name <email>` in each contribution commit (`git commit -s`).
- Before accepting code contributions, publish the **canonical, unmodified** Apache-2.0 LICENSE text and repository contribution instructions. Do not invent or abbreviate the legal terms.
- Every imported third-party dependency/source snippet remains subject to its own compatible license, notices and attribution requirements. Include any required NOTICE/attribution as determined by a dependency audit; adopting Apache-2.0 does not automatically relicense third-party code.
- Automated contribution checks may verify DCO metadata after CI is set up. Do not infer contributor identity/authorization merely from the sign-off string.

## Rationale

Apache-2.0 is widely used for infrastructure frameworks and supplies an explicit patent license; DCO avoids requiring contributors to transfer copyright. This choice does not imply review of every future dependency or legal compliance automatically.

## Remaining repository setup tasks

- Add the official LICENSE verbatim and DCO/contribution guidance, then validate against the canonical upstream source.
- Configure commit sign-off guidance and optional DCO CI verification after approved tooling scaffold exists.
- Determine package copyright/NOTICE conventions at the first release.

This ADR selects policy only: code implementation and publication of an initial release are still out of scope.
