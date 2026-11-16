# Machine capacity admission

The hub samples disk free space, swap, memory-pressure free percentage and one-minute load. It
does not start a new writer run, review or FLIGHT `start_seat` request while capacity is tight;
work already running is left alone. A single `machine-capacity` Needs you item names the measured
condition and the tracked agent consumers. The item keeps its original age and acknowledgement
through the whole capacity episode, including readings that move around a threshold. A
percentage-disk episode closes only after ten minutes above the configured floor plus one point
(6% with the default 5% floor). Other capacity conditions close after five minutes of headroom.

The percentage breach timestamp is stored in hub settings, so a restart or the original reading
leaving short history cannot clear an episode. The item keeps its original timestamp and dismissal
while its measured condition and consumer details update. FLIGHT uses the episode timestamp for
freshness, so a later episode gets a new wake.

Every 10 seconds the hub reads load, memory and disk from the operating system. It spawns
`vm_stat`, `sysctl vm.swapusage`, `memory_pressure` and `ps` only while a browser is connected,
a queued ticket, a queued review or a ticket run is open, or the guard is holding starts. An idle
hub with no browser spawns nothing, and the swap and memory-pressure readings keep their last
values until work appears.

Configure the limits below `crew.machine_capacity` in `config.yaml` (all values have defaults):

- `disk_free_gb: 15` and `disk_free_pct: 5` block when either free-space floor is crossed.
- `swap_used_pct: 60` is measured against physical RAM, never the macOS swap-file size. It
  blocks with `memory_free_pct: 10` when both floors are crossed; swap alone blocks above 90% of
  RAM. `load_per_core: 1.5` sets the other floor.
- Two fixed stops (#1812), for the fault where the file-change service (`fseventsd`) swells and
  pushes memory into swap: swap used over 85% of the swap file when that swap is also over 50%
  of RAM (a small swap file that is nearly full is normal and does not block), and `fseventsd`
  holding over 2 GB. The second reads its memory with compressed pages counted (`top`, run with
  `pgrep` beside `ps` when the spawns above run), because `ps` RSS leaves compressed pages out.
  The Needs-you item then says to run `sudo killall fseventsd` (about 15 seconds, no Mac
  restart). At start the hub also writes `.metadata_never_index` into the crew worktrees folder
  and the evidence folders so Spotlight stays out of them.
- `load_window_min: 5` requires sustained load; `clear_after_min: 5` avoids start/stop churn.

The dashboard API's `/api/machine` response includes the latest disk and swap readings and a
`warning` string while admission is held. To test safely, temporarily set a floor above the
current reading, reload the hub configuration, and attempt a start. The start is held with the
measured reason. Send `force: true` only to confirm that an operator override can start it; the
override is recorded in the decision log. Remove the threshold override after the check. The
warning and start admission clear automatically after sustained headroom.

## One worktree per seat (#1976)

A build seat keeps one worktree per repo, `{crew.worktrees}/{session}/{seat}-tree`, and a review
seat keeps `{seat}-review`. A new ticket moves the tree onto its branch instead of making a
worktree, so the Mac no longer writes and deletes about 12,000 files per ticket and per review.

- **Switch.** The hub refuses the move when the tree holds uncommitted changes and names the files
  in the start error; commit or discard them (a run's end already needs its work on the branch).
  It then removes what the last ticket left outside git (untracked and ignored files), keeping
  `node_modules`. A branch another idle seat tree still has checked out is detached there first.
- **Install only on change.** The hash of the install inputs of the last install (every
  `package.json`, the lockfile, `pnpm-workspace.yaml`, `.npmrc`, `.pnpmfile.*`, read from git
  objects) is kept in `{crew.worktrees}/.mc-install/{session}/`, outside every seat's tree. A start
  whose inputs match skips `pnpm install`; one whose inputs differ reinstalls. The checks on
  install inputs (`refuseInstallInputs`, `inspectDisk`, `refuseChangedInputs`) run on every start
  either way.
- **Parked tickets.** A ticket that waits for review keeps its branch, not a tree. Resuming it
  moves the seat's tree back to the branch; that is refused while the tree holds uncommitted
  changes.
- **uv repos** (a `uv.lock` at the top) use the same seat trees. A moved tree's `.venv` is always
  dropped and made again through the verified `uv sync` (uv's own cache keeps it quick): a venv a
  seat could write is not vouched for by the input checks, so it is not carried over.
- **Handed-over runs.** A run handed to another seat sits in the first seat's tree. If that seat
  has moved the tree on while the run waits, the resume takes the branch back once no other seat's
  run holds the tree; until then the wake answers 409 and the engine retries.
- **Old trees.** `{seat}-{issue}` and `{seat}-review-{id}` trees of runs already live stay where
  they are; the crew tidy removes them once their runs end. The tidy keeps the tree of a seat that
  is in the crew config, and removes one whose seat has been dropped from it (with its install
  record) once its runs are finished.
- **Measuring.** Count `git worktree add` runs per day, and the entries of `git worktree list` in
  the crew clone: at most one per seat (and one per review seat) once the old trees are gone.
- **Spotlight.** The hub's `.metadata_never_index` file is honoured only at a volume's root. A
  folder whose name ends in `.noindex` is skipped by Spotlight; this could not be checked from the
  seat's sandbox (`mdfind` returns nothing there). If `mdfind -onlyin <crew worktrees folder>
  package.json` still lists files, add the folder under System Settings > Spotlight > Search
  Privacy, or point `crew.worktrees` at a folder named `worktrees.noindex`.
