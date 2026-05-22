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

## Harness layer for long-running work

The training lane now uses a harness modeled on Anthropic's long-running app design:

1. **Planner / contract**
   - writes a structured `contract.json`
   - freezes execution inputs, retry policy, and evaluator criteria
2. **Generator / executor**
   - performs one concrete attempt at the task
   - writes a durable attempt artifact before the evaluator makes any decision
3. **Evaluator**
   - judges the attempt against explicit checks
   - accepts, retries, or blocks
4. **Handoff**
   - `run-state.json` and `evaluation.json` tell the next session exactly what happened

This matters because the main failure mode of semi-automatic systems is not "one bug." It is the lack of a durable control loop. Without a contract and evaluator, the scheduler can only launch work and hope.

### What RanchMind now preserves

- the agreed contract for the run
- each attempt and its raw output
- the evaluator's checks and final decision
- the final receipt that updates the Human plane memory

### Retry boundaries

RanchMind intentionally separates two cases:

- **Execution failure** -> automatic retry
- **Policy / metric failure** -> block for operator review

That prevents the common anti-pattern where a scheduler keeps rerunning a bad job indefinitely just because the previous run did not look good enough.

## Feishu runtime persistence

The messaging side has a different failure mode from the training lane: a gateway can stay **alive but broken** for hours if upstream auth is rejected and no component takes responsibility for classifying the state.

RanchMind now treats the Feishu-facing runtime as a supervised subsystem with four steps:

1. **Inspect**
   - source Codex auth
   - Hermes runtime auth pool state
   - gateway PID/state files
   - recent gateway log tail
2. **Classify**
   - healthy
   - recovering
   - degraded
   - blocked
3. **Act**
   - sync runtime auth when the source token is healthy
   - start the Hermes Gateway task if the gateway is down
   - kill the stuck gateway PID so the existing Hermes launcher can restart it
   - refuse to restart when the source token fingerprint matches a server-rejected token
4. **Persist**
   - write durable watchdog state into the Human plane memory

The key design choice is that RanchMind does **not** try to replace Hermes' launcher loop. It supervises it from above and only nudges it when the current state justifies intervention.

## Memory-fed scheduling rules

RanchMind now has a report-only scheduling policy layer that sits between the Human and Horse planes.

1. **Read memory**
   - latest training harness run
   - recent training history
   - latest Feishu runtime snapshot
2. **Interpret**
   - degrade the training lane when the latest harness run is `failed` or `blocked`
   - keep Feishu health advisory-only because notification outages do not invalidate local KD execution
   - mark Feishu state as stale if the watchdog snapshot is older than the expected supervision window
3. **Persist**
   - write `scheduling-policy-latest.json` / `.md`
   - append `scheduling-policy-history.jsonl`
4. **Expose**
   - `status` includes the latest computed policy so the operator can see whether the next dispatch should be trusted

This is intentionally **not** a hard execution gate yet. The point of v0 is to make memory influence dispatch visibility first, without creating stale-policy races that could suppress valid training runs.

## Bounded autonomy loop

RanchMind now adds a higher-level improvement harness above the training lane and Feishu watchdog.

1. **Mine structured signals**
   - recent training history
   - recent Feishu runtime history
   - latest scheduling policy snapshot
2. **Baseline**
   - compute autonomy ratio
   - count successful, skipped, and blocked/failed runs
   - summarize quality metrics from successful runs
3. **Plan**
   - produce ranked **operational** candidates
   - produce ranked **quality** candidates
   - keep risky changes such as metric-threshold edits in operator-review mode
4. **Evaluate**
   - write explicit insights about what still blocks unattended QMT autonomy
   - persist a loop result the next session can inspect before making another change

This loop is intentionally **bounded** and currently runs in `recommend_only` mode. The goal is to create a repeatable discover -> analyze -> validate -> evaluate cycle without pretending the system is already safe to self-edit indefinitely.

## Cross-platform runtime layer

The current repo now treats the control layer as **portable**, with platform adapters below it.

### Control layer

- `scripts/ranchmind.mjs`
- config loading and token expansion
- planner / evaluator orchestration
- receipt writing
- memory ledger updates
- platform detection

### Platform adapters

#### Windows

- training via the existing KD PowerShell script
- scheduling via Windows Scheduled Task that now calls the Node harness entrypoint
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
