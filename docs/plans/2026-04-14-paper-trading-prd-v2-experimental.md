# Paper Trading System v2 PRD for Experimental Branch

## Purpose

Define the paper trading redesign against the latest `experimental` branch of Meridian, not against the older `main`-based fork.

This PRD supersedes the prototype design discussion from the previous repo state. It assumes implementation will happen on branch:
- repo: `/workspace/meridian`
- base branch: `upstream/experimental`
- working branch: `paper-trading-prd-v2`

## Executive Summary

Experimental branch changes the integration landscape materially:
- richer Telegram control surface already exists
- CLI is first-class and broader than main
- deterministic management/screening flow is more advanced
- Darwinian signal weighting exists
- HiveMind sync exists
- Agent Meridian API / LPAgent relay integrations exist
- chart-indicator confirmation hooks exist
- expanded screening and executor/config surfaces exist

Good news:
- there is no existing paper trading subsystem on this experimental branch
- so we do not need to preserve a flawed split-state paper implementation here
- this makes a clean design easier

Therefore the right direction is:
- build paper trading as a new subsystem native to experimental architecture
- integrate at executor/CLI/reporting boundaries
- keep paper trading isolated from live state and external relay features
- make it auditable, deterministic, and compatible with existing operator UX

## What changed in experimental that matters for this PRD

Compared with main, experimental adds or materially expands:

1. Telegram control commands
- Telegram handler already supports rich command handling (`/help`, `/wallet`, `/status`, `/config`, `/positions`, `/pool`, `/close`, `/closeall`, `/set`, `/setcfg`, `/screen`, `/candidates`, `/pause`, `/resume`, `/hive`)
- paper trading must fit this operator-facing control model

2. Deterministic orchestration and polling
- management/screening cycles are more structured
- poll-triggered management and deterministic close logic are more developed
- paper subsystem should hook into these flows without duplicating orchestration logic

3. Config surface is larger
- `config.js` now includes sections for:
  - `screening`
  - `management`
  - `darwin`
  - `hiveMind`
  - `api`
  - `indicators`
- paper trading should be added as its own first-class config section, not scattered across existing sections

4. Signal and explanation systems exist
- `signal-tracker.js`
- `signal-weights.js`
- `decision-log.js`
- paper trading should emit structured decision/accounting events without conflicting with these systems

5. Agent Meridian / LPAgent relay exists
- some features route through Agent Meridian API
- paper trading must not accidentally call live execution or relay pathways when simulating

6. Experimental currently has no paper engine
- no existing `paper-learning.js`
- no existing `paper-wallet.js`
- no current canonical paper abstraction to preserve
- this supports a clean greenfield implementation

## Product Goal

When `DRY_RUN=true`, Meridian should be able to operate in a realistic simulated execution mode backed by a dedicated paper trading engine that:
- owns its own capital model
- tracks open and closed paper trades
- performs deterministic exposure checks
- records structured events for every state transition
- produces operator-grade status and audit views
- integrates cleanly with the experimental branch’s CLI, Telegram, executor, and cycle orchestration

## Design Decision

Paper trading in experimental should be implemented as a domain subsystem, not as:
- a CLI-only add-on
- a wallet helper
- a patch inside executor safety checks
- a sidecar JSON file pair

This subsystem should sit conceptually between:
- tool/executor intent
and
- simulated trade/accounting persistence

## Architectural Principles

1. One canonical persisted state
2. Explicit event log
3. Deterministic trade lifecycle
4. Pure preflight validation
5. Atomic open/mark/close transitions
6. Isolation from live wallet and relay execution
7. Auditability from a single persisted source
8. Compatibility with experimental CLI/Telegram surfaces

## Scope

In scope:
- paper capital
- paper trade lifecycle
- preflight checks
- trade marking/evaluation
- paper status/reporting
- CLI integration
- optional Telegram read-only status integration
- reconciliation and audit

Out of scope:
- exact on-chain simulation
- full LP fill accuracy
- replacing live trading logic
- redesigning Darwin/HiveMind/indicator systems
- exact import migration from previous branch’s paper prototype

## Integration Strategy for Experimental Branch

### 1. Add a new config section

Add:
- `config.paper`

Expected fields:
- `enabled`
- `startingBalanceSol`
- `maxOpenTrades`
- `evaluationHorizonsMin`
- `primaryHorizonMin`
- `takeProfitPct`
- `stopLossPct`
- `autoCloseAtMaxHorizon`
- `reserveGasBufferSol`
- `telegramStatusEnabled` (optional, read-only reporting)

Do not overload:
- `management`
- `risk`
- `darwin`

except where shared values are intentionally referenced.

### 2. Add canonical paper state file

Use one file:
- `paper-state.json`

No split source of truth.

State contains:
- metadata
- wallet snapshot
- open trades
- closed trades
- events
- reconciliation metadata

### 3. Add dedicated modules

Recommended new modules:
- `paper-state.js` — load/save/transaction/reconcile
- `paper-engine.js` — preflight/open/mark/close/status
- `paper-evaluator.js` — evaluation/return estimation/horizon logic

Optional:
- `paper-reporting.js` if formatting/report projection becomes large

### 4. Integrate at executor boundary

Experimental already routes execution through `tools/executor.js`.
That is the correct primary integration point.

Rule:
- live mode -> existing live execution path
- DRY_RUN paper enabled -> simulated execution path

Specifically:
- `deploy_position` should call paper preflight + paper open instead of pretending success without accounting
- `close_position` in DRY_RUN should close paper trades, not call live close
- read-only tools should continue using market data/live APIs as needed for analysis

### 5. Integrate at cycle boundary, not orchestration boundary

`index.js` orchestration in experimental is already complex.
Do not rewrite cycle orchestration.

Instead:
- let screening cycle continue deciding candidates
- let management cycle continue deciding actions
- plug paper engine into the points where deploy/close state changes occur

### 6. Integrate with CLI first-class

Experimental branch already has strong CLI support.
Paper trading must expose first-class CLI commands, not hidden developer scripts.

Required commands:
- `node cli.js paper status`
- `node cli.js paper wallet`
- `node cli.js paper ledger [--limit N]`
- `node cli.js paper init --balance <sol>`
- `node cli.js paper reset --balance <sol>`
- `node cli.js paper deposit --amount <sol>`
- `node cli.js paper withdraw --amount <sol>`
- `node cli.js paper reconcile`
- `node cli.js paper inspect --trade <id>`
- `node cli.js paper rejects [--limit N]`
- `node cli.js paper purge`

### 7. Integrate with Telegram conservatively

Because experimental already has rich Telegram controls, paper trading should initially add only read-oriented Telegram support:
- `/paper`
- `/paperwallet`
- maybe `/papertrade <id>`

Avoid adding mutable Telegram paper commands in v1 unless necessary.

### 8. Keep paper state separate from learning systems

Experimental includes:
- `lessons.js`
- `signal-tracker.js`
- `signal-weights.js`
- HiveMind pull/push systems

Paper trading should not directly write into these systems until the subsystem is stable.

Recommended v1 behavior:
- paper engine emits its own events and summaries
- downstream learning integration can happen later via an adapter layer

## Core Product Requirements

### PR1. Independent paper capital
Paper mode uses its own persisted balance and reservation model.

### PR2. One canonical paper state
All paper runtime truth must come from `paper-state.json`.

### PR3. Event ledger
Every meaningful transition must append an event.

### PR4. Deterministic preflight
Paper preflight returns structured, machine-readable validation with no mutation.

### PR5. Explicit exposure keys
Paper dedupe must use normalized keys:
- pool key
- token key
- optional pair key

Null identifiers must not silently collide.

### PR6. Atomic transitions
Trade open/mark/close must be atomic from persisted-state perspective.

### PR7. Reconciliation
System must be able to verify and repair/flag invariant drift.

### PR8. Executor compatibility
Paper mode must slot into `tools/executor.js` cleanly without forking major orchestration logic.

### PR9. CLI compatibility
Paper mode must be inspectable and operable through existing CLI ergonomics.

### PR10. Telegram compatibility
Paper mode must provide operator-readable state in Telegram without destabilizing live command UX.

### PR11. Relay isolation
When paper mode is active, no live execution path or Agent Meridian relay should be called for state-changing trade actions.

### PR12. Learning isolation in v1
Paper subsystem should not directly mutate Darwin/HiveMind/live lessons until a deliberate integration phase.

## Domain Model

### Wallet snapshot
- starting balance
- free balance
- reserved balance
- realized pnl
- unrealized pnl
- equity

### Open trade
- id
- source
- requested/accepted/open timestamps
- pool identifiers
- token identifiers
- strategy metadata
- allocated capital
- entry snapshot
- latest mark
- evaluation history
- status

### Closed trade
Open trade +:
- close reason code
- closed timestamp
- realized pnl
- final return
- outcome classification

### Event types
- wallet_initialized
- wallet_reset
- capital_deposited
- capital_withdrawn
- deploy_requested
- deploy_rejected
- trade_opened
- trade_marked
- trade_close_requested
- trade_closed
- reconciliation_run
- reconciliation_error

## Invariants

1. `equity = free + reserved + unrealized`
2. `reserved = sum(open_trade.allocated_sol)`
3. `realized_pnl = sum(closed_trade.realized_pnl_sol)`
4. no open trade may lack reserved capital
5. rejected deploys must not mutate wallet or open trades
6. preflight must be side-effect free
7. duplicate conflict reason must identify pool/token basis
8. DRY_RUN paper path must never call live close/deploy execution

## Experimental-Branch-Specific Constraints

### Constraint A: do not fight deterministic screen/manage logic
Use adapters at state-changing boundaries, not orchestration rewrites.

### Constraint B: preserve `executeTool` semantics
Tool results should still look useful to the agent even when paper mode is active.
The agent should receive a success-like simulated result shape where appropriate.

### Constraint C: preserve operator explanation flows
If decisions are appended to `decision-log.js`, paper-mode state changes should remain explainable and auditable.

### Constraint D: avoid coupling to HiveMind in v1
Paper trade results should not automatically sync to HiveMind until explicitly designed.

### Constraint E: avoid coupling to Darwin weights in v1
Do not make paper trades directly influence signal weights in first release.
Capture compatibility hooks only.

## Rejected Approaches

1. Recreate split `paper-trades.json` + `paper-wallet.json`
2. Patch live wallet helpers to fake paper balances
3. Put paper logic directly into `index.js` orchestration
4. Let invalid tool attempts poison later valid attempts in the same cycle
5. Blend paper accounting with HiveMind/Darwin/live lessons immediately

## Proposed Delivery Phases

### Phase 0 — Spec finalization
- finalize this PRD against experimental architecture

### Phase 1 — State engine
- create `paper-state.js`
- create canonical persistence + reconciliation

### Phase 2 — Core paper engine
- preflight
- open
- mark
- close
- status projections

### Phase 3 — Executor integration
- wire DRY_RUN deploy/close to paper engine
- preserve read-only tool behavior

### Phase 4 — CLI/Telegram reporting
- CLI commands
- read-only Telegram paper commands

### Phase 5 — Optional learning adapters
- only after core engine is stable
- evaluate Darwin/HiveMind/lesson integrations separately

## Test Strategy

### Unit tests
- preflight success
- insufficient funds rejection
- duplicate pool rejection
- duplicate token rejection
- null token identifier handling
- atomic open success/failure
- mark updates wallet snapshot
- close realizes pnl and releases reservation
- reconciliation invariants

### Integration tests
- DRY_RUN deploy opens paper trade via executor
- DRY_RUN close closes paper trade via executor
- management evaluation marks/updates open trades
- invalid deploy attempt does not poison next valid attempt
- simulated results remain agent-compatible

### Experimental compatibility tests
- CLI commands return expected JSON shapes
- Telegram `/paper` and `/paperwallet` are read-only and stable
- DRY_RUN path does not touch live relay execution
- existing deterministic cycles still run without architectural regression

## Files likely to change

Create:
- `paper-state.js`
- `paper-engine.js`
- `paper-evaluator.js`
- `test/test-paper-state.js`
- `test/test-paper-engine.js`
- `test/test-paper-integration.js`

Modify:
- `config.js`
- `user-config.example.json`
- `tools/executor.js`
- `cli.js`
- `index.js`
- `telegram.js`
- `README.md`
- possibly `tools/definitions.js`

## Integrations Compatibility Guidance

### HiveMind
- Keep HiveMind operationally available but paper trading v1 should not publish paper results into HiveMind automatically.
- Paper subsystem may read HiveMind-influenced candidate selection indirectly through existing screening flows, but paper accounting must remain locally canonical.
- Future integration, if desired, should happen through an explicit adapter that converts closed paper trades into opt-in shared lessons.

### Darwinian Signal Weighting
- Darwin remains an upstream screening signal system, not a paper-accounting system.
- Paper v1 should not directly mutate Darwin weights.
- If we later decide to let paper outcomes influence Darwin, that must be an explicit feature gate with its own confidence rules and sample thresholds.

### LPAgent / Agent Meridian Relay
- In DRY_RUN paper mode, no state-changing relay call should be used for deploy/close.
- Read-only market/study endpoints may still be used when useful.
- The paper engine must short-circuit execution before any live relay pathway is invoked.

### Chart Indicator Hooks
- Indicator confirmation hooks should remain compatible and usable in paper mode.
- They may influence simulated entry/exit decisions because they are decision inputs, not execution paths.
- If indicator API is unavailable, paper mode should follow the same graceful fallback semantics used elsewhere in experimental.

## Final Recommendation

Implement paper trading as a brand new subsystem tailored to experimental branch architecture.

Do not port the earlier prototype code.
Port only:
- concepts that worked
- observed failure modes as tests
- operator requirements

The experimental branch is advanced enough that paper trading should now be introduced as a proper engine, not as a retrofit.
