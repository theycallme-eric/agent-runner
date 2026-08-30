# Agent Runner instructions

Read `README.md`, `docs/architecture.md`, and `docs/landscape.md` before changing this repository.

The controller must remain project- and model-agnostic. Do not add CLEAR-specific behavior to core
code; represent it through a project adapter or fixture. Prefer adopting stable, permissively
licensed components over recreating agent runtimes, worktree managers, or specification systems.

Reliability claims require deterministic evidence. Simulator coverage must include duplicate claims,
worker crashes, controller restarts, stale leases, advanced base branches, invalid worker success,
failing CI, protected-path changes, and human gates before real unattended execution is enabled.

Do not add secrets, credentials, raw private transcripts, or personal project data. Never enable
automatic merging without a separately reviewed policy and protected-branch enforcement.
