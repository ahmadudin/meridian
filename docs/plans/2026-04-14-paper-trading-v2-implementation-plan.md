# Paper Trading System v2 Implementation Plan

> For Hermes: execute this plan on `/workspace/meridian` branch `paper-trading-prd-v2`, using the experimental-branch PRD as source of truth.

Goal: build a new paper trading subsystem for DRY_RUN mode that is native to experimental branch architecture, with one canonical state file, deterministic preflight validation, atomic transitions, CLI support, and safe integration with executor/cycle flows.

Architecture: introduce a dedicated paper domain layer (`paper-state.js`, `paper-engine.js`, `paper-evaluator.js`) and integrate it at `tools/executor.js`, `cli.js`, and minimal read-only Telegram/reporting points. Do not port the prior prototype implementation.

Tech stack: Node.js ESM, JSON persistence, existing experimental CLI/Telegram/executor architecture, Node test files in `test/`.

---

## Task 1: Add paper config section to runtime config

Objective: create a first-class `config.paper` section so paper mode is explicit and isolated.

Files:
- Modify: `config.js`
- Modify: `user-config.example.json`
- Test: `test/test-paper-config.js`

Steps:
1. Add `config.paper` in `config.js` with fields:
   - `enabled`
   - `startingBalanceSol`
   - `maxOpenTrades`
   - `evaluationHorizonsMin`
   - `primaryHorizonMin`
   - `takeProfitPct`
   - `stopLossPct`
   - `autoCloseAtMaxHorizon`
   - `reserveGasBufferSol`
   - `telegramStatusEnabled`
2. Add matching example values to `user-config.example.json`.
3. Add a test that imports `config.js` and verifies defaults exist and types are correct.
4. Run targeted test.

Verification:
- `node test/test-paper-config.js`

Commit message:
- `feat: add paper trading config section`

---

## Task 2: Create canonical paper state module

Objective: establish one persisted source of truth via `paper-state.json`.

Files:
- Create: `paper-state.js`
- Create: `test/test-paper-state.js`

Steps:
1. Implement state shape with:
   - metadata
   - wallet snapshot
   - open_trades
   - closed_trades
   - events
   - reconciliation metadata
2. Add helpers:
   - `loadPaperState()`
   - `savePaperState()`
   - `initializePaperState()`
   - `resetPaperState()`
3. Add file-path override support for tests.
4. Write tests for initialization and persistence.

Verification:
- `node test/test-paper-state.js`

Commit message:
- `feat: add canonical paper state persistence`

---

## Task 3: Add reconciliation and invariants

Objective: make the paper state auditable and internally consistent.

Files:
- Modify: `paper-state.js`
- Modify: `test/test-paper-state.js`

Steps:
1. Implement invariant checks:
   - equity = free + reserved + unrealized
   - reserved = sum(open trade allocations)
   - realized = sum(closed trade pnl)
2. Add `reconcilePaperState()`.
3. Add event emission for reconciliation runs/errors.
4. Add failing tests first, then implementation.

Verification:
- `node test/test-paper-state.js`

Commit message:
- `feat: add paper state reconciliation and invariants`

---

## Task 4: Create pure preflight validation engine

Objective: separate paper deploy validation from execution and make it side-effect free.

Files:
- Create: `paper-engine.js`
- Create: `test/test-paper-engine.js`

Steps:
1. Implement normalized exposure keys:
   - pool key
   - token key
   - optional pair key
2. Implement `preflightPaperDeploy(args, state, config)` returning:
   - `ok`
   - `reason_code`
   - `reason`
   - `available_free_sol`
   - `required_free_sol`
   - `conflicts`
3. Cover cases:
   - valid deploy
   - insufficient balance
   - duplicate pool
   - duplicate token
   - null token does not falsely collide
4. Ensure preflight does not mutate state.

Verification:
- `node test/test-paper-engine.js`

Commit message:
- `feat: add pure paper deploy preflight engine`

---

## Task 5: Implement atomic trade open

Objective: open a paper trade and reserve capital atomically.

Files:
- Modify: `paper-engine.js`
- Modify: `test/test-paper-engine.js`

Steps:
1. Implement `openPaperTrade()`.
2. Flow:
   - record request event
   - run preflight
   - if rejected: append rejection event only
   - if accepted: create open trade + reserve capital + update wallet + append open event atomically
3. Add tests ensuring failed opens leave no partial reservation.
4. Add tests ensuring accepted open creates open trade and reservation together.

Verification:
- `node test/test-paper-engine.js`

Commit message:
- `feat: add atomic paper trade open flow`

---

## Task 6: Implement mark-to-market and evaluation support

Objective: support periodic updates of open paper trades without closing them.

Files:
- Create: `paper-evaluator.js`
- Modify: `paper-engine.js`
- Create: `test/test-paper-evaluator.js`

Steps:
1. Implement `estimatePaperReturn()`.
2. Implement `markPaperTrade()` for latest mark snapshots.
3. Implement `evaluatePaperTrades()` using configured horizons.
4. Update wallet unrealized PnL projection from open trade marks.
5. Add tests for:
   - mark updates
   - evaluation horizon storage
   - unrealized pnl propagation

Verification:
- `node test/test-paper-evaluator.js`

Commit message:
- `feat: add paper trade evaluation and mark-to-market`

---

## Task 7: Implement close flow

Objective: close paper trades cleanly and realize PnL.

Files:
- Modify: `paper-engine.js`
- Modify: `paper-evaluator.js`
- Modify: `test/test-paper-engine.js`
- Modify: `test/test-paper-evaluator.js`

Steps:
1. Implement `closePaperTrade()`.
2. Move trade from open to closed atomically.
3. Release reservation and update realized PnL.
4. Require machine-readable close reason codes.
5. Add tests for threshold close and max-horizon close.

Verification:
- `node test/test-paper-engine.js`
- `node test/test-paper-evaluator.js`

Commit message:
- `feat: add atomic paper trade close flow`

---

## Task 8: Add status and ledger projections

Objective: make paper state easy to inspect from CLI and reports.

Files:
- Modify: `paper-engine.js`
- Modify: `test/test-paper-engine.js`

Steps:
1. Add projection helpers:
   - `getPaperStatus()`
   - `getPaperWalletSummary()`
   - `getPaperLedger()`
   - `getPaperRejectSummary()`
   - `getPaperTradeById()`
2. Keep these read-only projections from canonical state.
3. Test JSON output shape and summary fields.

Verification:
- `node test/test-paper-engine.js`

Commit message:
- `feat: add paper status and ledger projections`

---

## Task 9: Wire DRY_RUN deploy path through paper engine

Objective: integrate paper mode into experimental executor without changing orchestration design.

Files:
- Modify: `tools/executor.js`
- Modify: `test/test-paper-integration.js`

Steps:
1. Intercept `deploy_position` in DRY_RUN + paper enabled mode.
2. Use paper preflight/open instead of live execution.
3. Return agent-compatible simulated success/rejection shapes.
4. Ensure invalid deploy attempts do not poison later valid attempts.
5. Add regression tests for:
   - false duplicate exposure prevention
   - invalid amount followed by valid amount in same cycle

Verification:
- `node test/test-paper-integration.js`

Commit message:
- `feat: wire dry-run deploys to paper engine`

---

## Task 10: Wire DRY_RUN close path through paper engine

Objective: ensure simulated closes do not call live execution.

Files:
- Modify: `tools/executor.js`
- Modify: `test/test-paper-integration.js`

Steps:
1. Intercept `close_position` in DRY_RUN + paper enabled mode.
2. Close the matching paper trade through paper engine.
3. Ensure no live relay / on-chain execution path is invoked.
4. Add integration tests for DRY_RUN close behavior.

Verification:
- `node test/test-paper-integration.js`

Commit message:
- `feat: wire dry-run closes to paper engine`

---

## Task 11: Add CLI paper commands

Objective: expose paper mode as a first-class operator interface.

Files:
- Modify: `cli.js`
- Modify: `test/test-paper-integration.js`

Steps:
1. Add commands:
   - `paper status`
   - `paper wallet`
   - `paper ledger`
   - `paper init`
   - `paper reset`
   - `paper deposit`
   - `paper withdraw`
   - `paper reconcile`
   - `paper inspect`
   - `paper rejects`
   - `paper purge`
2. Keep output JSON-first and aligned with existing CLI conventions.
3. Add CLI smoke tests.

Verification:
- `node cli.js paper status`
- `node cli.js paper wallet`
- `node test/test-paper-integration.js`

Commit message:
- `feat: add first-class paper cli commands`

---

## Task 12: Add minimal Telegram read-only paper commands

Objective: expose paper state without adding risky mutable Telegram control in v1.

Files:
- Modify: `index.js`
- Possibly modify: `telegram.js`
- Modify: `README.md`

Steps:
1. Add read-only Telegram commands:
   - `/paper`
   - `/paperwallet`
   - optionally `/papertrade <id>`
2. Reuse paper projection helpers.
3. Do not add mutable paper Telegram actions in v1.
4. Document commands.

Verification:
- local code path review
- optional manual Telegram smoke later

Commit message:
- `feat: add read-only telegram paper status commands`

---

## Task 13: Documentation and migration notes

Objective: document paper v2 clearly and avoid accidental reuse of old prototype assumptions.

Files:
- Modify: `README.md`
- Modify: `user-config.example.json`
- Modify: `docs/plans/2026-04-14-paper-trading-prd-v2-experimental.md` if needed

Steps:
1. Add user-facing docs for paper mode.
2. Document that paper mode is canonical via `paper-state.json`.
3. Document that v1 paper mode does not sync into HiveMind/Darwin automatically.
4. Document relay isolation in DRY_RUN paper mode.

Verification:
- manual docs review

Commit message:
- `docs: document paper trading v2`

---

## Task 14: Final validation

Objective: prove the subsystem is stable enough for use.

Files:
- none or all touched files as needed

Steps:
1. Run all targeted paper tests.
2. Run existing core smoke checks that should still pass.
3. Run CLI smoke commands.
4. Check git diff for accidental unrelated edits.

Verification commands:
- `node test/test-paper-config.js`
- `node test/test-paper-state.js`
- `node test/test-paper-engine.js`
- `node test/test-paper-evaluator.js`
- `node test/test-paper-integration.js`
- `node test/test-screening.js`
- `DRY_RUN=true node test/test-agent.js`
- `node cli.js paper status`
- `node cli.js paper wallet`

Commit message:
- `test: validate paper trading v2 integration`

---

## Notes for implementation

- Do not port old `paper-learning.js` / `paper-wallet.js` design.
- Port only failure modes as tests.
- Keep paper mode isolated from HiveMind, Darwin mutation, and live relay execution in v1.
- Prefer executor-boundary integration over orchestration rewrites in `index.js`.
- Preserve agent-compatible tool result shapes so the LLM flow does not regress.
