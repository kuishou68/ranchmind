# RanchMind

**Lobster + Horse + Human** in one closed-loop agent runtime.

RanchMind is a clean-room open-source project concept that combines three proven strengths into a single product:

- **Lobster**: CLI execution, coding backends, workspace action, tool-heavy work
- **Horse**: scheduling, messaging, dispatch, background autonomy
- **Human**: memory, control plane, personal context, UI and review

The goal is not to wrap three existing projects with a thin shell. The goal is to create a **closed loop**:

1. the **Horse** schedules or receives work
2. the **Lobster** executes it in a real workspace
3. the **Human** stores outcomes as durable memory and operator-facing context
4. the next task uses that memory to make better decisions

## Source strengths distilled

| Inspiration | Strength we keep | RanchMind plane |
| --- | --- | --- |
| OpenClaw-style systems | CLI backend abstraction, workspace execution, tool-heavy coding, local model adapters | Lobster |
| Hermes-style systems | channel gateway, cron automation, background dispatch, task fan-out | Horse |
| OpenHuman-style systems | personal memory, local-first context, UI-first control plane, human-centered product shape | Human |

## Why this exists

Today the ecosystem has strong single-purpose tools:

- execution-first tools
- messaging/scheduler-first tools
- memory/UI-first tools

What is still missing is a repo that treats those three strengths as first-class product planes under one architecture.

RanchMind is that architecture.

## Product position

RanchMind is a **control-plane product**, not just an agent farm.

- **Execution plane** is pluggable
- **Scheduler plane** is pluggable
- **Memory plane** is pluggable
- **Operator UX** is central

That means RanchMind can use OpenClaw-style execution, Hermes-style messaging/cron, and OpenHuman-style memory/UX ideas without being hard-coupled to any one upstream.

## Why not just use an existing agent farm

RanchMind is aimed at the gap above “multi-agent orchestration only”.

The thesis is:

- scheduling without memory is blind
- execution without operator UX is hard to trust
- memory without execution is passive

RanchMind treats those three concerns as one product, not three adjacent tools.

## Core planes

### 1. Human Plane

The Human Plane is the operator-facing layer.

- personal memory
- workspace summaries
- decision review
- safety policy
- approval surfaces
- local-first knowledge graph

### 2. Horse Plane

The Horse Plane is the dispatch layer.

- cron jobs
- inbox-triggered tasks
- Feishu/Telegram/Slack style channel delivery
- retries, throttling, escalation
- agent handoff

### 3. Lobster Plane

The Lobster Plane is the execution layer.

- CLI model adapters
- coding workspaces
- shell/tool actions
- backend routing
- result capture

## What makes RanchMind different

RanchMind is not just “another OpenClaw wrapper” and not just “another cron bot”.

Its differentiator is the **closed execution-memory loop**:

- jobs do not disappear after completion
- outputs become memory
- memory affects later planning
- operator context survives across tools and channels

## Inspiration, not bundled code

RanchMind is **inspired by** the strengths of projects like OpenClaw, Hermes, and OpenHuman.

This scaffold does **not** copy their code or claim affiliation. It is intended as a fresh open-source repo structure for a new product direction.

## Repo layout

```text
ranchmind/
  apps/
    human-plane/
  packages/
    horse-plane/
    lobster-plane/
    memory-plane/
  docs/
    architecture.md
    promo.md
  scripts/
    ranchmind.mjs
  prompts/
    gemini-animation.txt
  ranchmind.config.json
  LICENSE
  package.json
  pnpm-workspace.yaml
```

## Local MVP on this machine

This repo now includes a working local MVP for the **non-trading-day factor training** lane.

- **Lobster** runs the existing KD factor-training script
- **Horse** registers a RanchMind-branded Windows Scheduled Task
- **Human** writes durable receipts and memory summaries into `state\memory\`

### Commands

```powershell
node .\scripts\ranchmind.mjs status
node .\scripts\ranchmind.mjs run-training --date 2026-05-17 --source ranchmind.manual
node .\scripts\ranchmind.mjs register-training --disable-legacy
```

### Durable state

RanchMind keeps its own state under:

```text
state/
  memory/
    training-history.jsonl
    training-latest.json
    training-latest.md
  receipts/
    training/
```

The underlying KD workflow remains the authoritative execution source. RanchMind does not replace it; RanchMind wraps it, records it, and schedules it under its own control plane.

## Initial roadmap

- define clean backend contracts for scheduling, execution, and memory
- add a unified run ledger across all three planes
- add operator review UI for scheduled task results
- add memory-fed scheduling rules
- add pluggable channel adapters and local CLI backend adapters

## Launch line

> **Lobster + Horse + Human.**
> One writes code, one moves work, one remembers why it matters.

