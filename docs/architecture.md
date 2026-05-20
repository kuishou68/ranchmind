# RanchMind Architecture

## Summary

RanchMind splits the product into three planes:

- **Human Plane**: memory, review, policy, UI
- **Horse Plane**: scheduling, channel ingress/egress, automation dispatch
- **Lobster Plane**: execution engines, CLI backends, tool-running workspaces

The system is built around a single rule:

**every execution becomes memory, and every memory can influence later dispatch.**

## Plane responsibilities

### Human Plane

Owns:

- operator dashboard
- memory graph
- durable summaries
- approvals
- audit trail

Does not own:

- low-level task execution
- channel transport

### Horse Plane

Owns:

- cron and event triggers
- channel adapters
- retries and escalation
- queueing and fan-out
- task lifecycle transitions

Does not own:

- deep workspace execution
- final memory representation

### Lobster Plane

Owns:

- CLI backends
- shell toolchains
- coding workspaces
- execution receipts
- backend-specific adapters

Does not own:

- user-facing memory UX
- notification policy

## Closed-loop runtime

1. **Trigger**
   - cron, inbound message, webhook, or manual operator action
2. **Dispatch**
   - Horse Plane chooses lane, priority, and target backend
3. **Execution**
   - Lobster Plane performs coding/tool work and emits receipts
4. **Memory ingestion**
   - Human Plane stores summary, outputs, links, and outcomes
5. **Next action**
   - future dispatch can consult memory, policy, and operator context

## Cross-platform runtime layer

The current repo now treats the control layer as **portable**, with platform adapters below it.

### Control layer

- `scripts/ranchmind.mjs`
- config loading and token expansion
- receipt writing
- memory ledger updates
- platform detection

### Platform adapters

#### Windows

- training via the existing KD PowerShell script
- scheduling via Windows Scheduled Task
- status via `schtasks.exe` and local receipt inspection

#### macOS / Linux

- training via a configurable command that emits JSON
- scheduling via a user cron entry
- status via cron inspection plus local receipt inspection

This keeps the validated Windows lane intact while allowing the same RanchMind control plane to orchestrate non-Windows environments without hard-coding `powershell.exe` or Task Scheduler into the primary CLI.

## Adapter contract

Every execution adapter must return a JSON payload that RanchMind can record as a receipt. The control plane owns:

- request date
- invocation source
- receipt file path
- memory summaries

The adapter owns:

- how execution is launched
- platform-specific dependencies
- the payload fields inside `outcome`

This separation is what lets the same Human and Horse loops operate above different runtimes.

## Suggested package map

- `apps/human-plane`
  - dashboard
  - memory browser
  - task review UI
- `packages/horse-plane`
  - cron engine
  - channel adapters
  - dispatcher
- `packages/lobster-plane`
  - CLI backend adapter contract
  - workspace runner
  - receipt model
- `packages/memory-plane`
  - embeddings
  - summaries
  - entity graph
  - retrieval APIs

## Non-goals for v0

- replacing every upstream tool
- bundling private model providers by default
- pretending one agent should do everything

## v0 thesis

RanchMind wins if it becomes the easiest way to run:

- scheduled work
- workspace execution
- durable memory

inside one operator-friendly system.
