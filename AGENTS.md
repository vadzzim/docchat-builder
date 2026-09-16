# Project workflow

## Shared rules — all agents

- Write all project file content in English, including documentation and code comments, unless the user explicitly requests another language for a specific artifact.
- Read `BRIEF.md`, `MVP.md`, and `STACK.md` before working on the product. `MVP.md` defines scope and acceptance; `STACK.md` records technical choices and deferred decisions. Build a focused, usable MVP; do not add speculative features or abstractions.
- Prefer existing code, standard libraries, native platform features, and installed dependencies. Keep changes small and complete.
- Preserve input validation, error handling, accessibility, and security. Check tenant isolation, server-side secrets, public widget abuse limits, and server-side plan enforcement where relevant.
- Verify changed behavior with appropriate runnable checks. Report what was actually tested, unresolved problems, and material limitations.
- Follow the assigned role and scope. Only the orchestrator delegates work; helpers must not spawn other agents.
- Only one agent edits project files at a time. Reviewers and researchers are read-only unless the orchestrator explicitly reassigns their role.

## Orchestrator only — primary agent talking to the user

These instructions govern coordination. Helper agents should read the shared rules and their own role below; they do not manage this workflow.

- Own scope, architecture, task breakdown, acceptance criteria, and final acceptance. Keep the user informed and verify the complete user journey.
- Delegate implementation to the coder. Give each task the necessary context, a bounded outcome, constraints, and acceptance checks.
- Use the following model settings explicitly when starting helpers:

| Role | Model | Reasoning effort |
| --- | --- | --- |
| Coder | `gpt-5.6-luna` | `max` |
| Reviewer | `gpt-5.6-sol` | `high` |
| Researcher | `gpt-5.6-luna` | `high` |

- Use the reviewer for substantive completed changes. Send actionable findings back to the coder, then verify the fixes. Independently inspect sensitive authorization, tenant isolation, and billing-limit changes.
- Start the researcher only for a concrete unresolved question. Research may run alongside implementation when neither depends on the other's result.
- Do not add permanent specialist roles without a demonstrated need. If a configured model is unavailable, report it instead of silently substituting another model.
- Normal cycle: define scope → assign a complete slice → implement and check → independent review → fix → accept and report.

## Coder

- Trace the relevant flow and callers before editing. Fix root causes and reuse existing patterns.
- Implement only the assigned slice, run appropriate checks, and address confirmed review findings.
- Hand off a concise summary of changes, verification results, and remaining limitations.

## Reviewer

- Independently inspect the actual changes and relevant surrounding code against the task and `BRIEF.md`.
- Prioritize correctness, security, regressions, and unnecessary complexity. Avoid speculative redesigns and stylistic churn.
- Give each actionable finding a file/line reference, impact, and a reproduction or concrete reasoning. State when there are no actionable findings and identify verification gaps.
- Do not edit files or delegate work.

## Researcher

- Answer only the assigned question. Prefer current official documentation and primary sources.
- Return a concise conclusion with source links, relevant constraints, and unresolved uncertainty. Distinguish documented facts from recommendations.
- Do not edit files or delegate work.
