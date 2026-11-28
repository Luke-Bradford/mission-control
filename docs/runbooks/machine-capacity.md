# Machine capacity admission

The hub samples disk free space, swap, memory-pressure free percentage and one-minute load. It
does not start a new writer run, review or FLIGHT `start_seat` request while capacity is tight;
work already running is left alone. A single `machine-capacity` Needs you item names the measured
condition and the tracked agent consumers. The item keeps its original age and acknowledgement
through the whole capacity episode, including readings that move around a threshold. A
percentage-disk episode closes only after ten minutes above the configured floor plus one point
(6% with the default 5% floor). Other capacity conditions close after five minutes of headroom.
A separate `disk-low` item opens once when free disk falls below 10%, even if the lower admission
floor has not been crossed. It closes when free disk reaches 10% again.

Each hourly leftovers pass compresses crew Claude and Codex session transcripts after 24 hours and
deletes them after 14 days. It removes Playwright profiles and Chrome temporary entries older than
six hours only when no live process names the entry. Claude and Codex files are selected only when
their recorded worktree is under `crew.worktrees`; live worktrees are left alone. Ended worktrees
already leave through the ten-minute crew tidy when their ticket closes or their PR merges or
closes. The Machine response also reports byte counts for those transcript and browser stores;
`/api/disk-use` reports the worktree total.

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
  holding over 6 GB (it made the Mac unusable at 7 GB on 29 October). The second reads its memory
  with compressed pages counted (`top`, run with `pgrep` beside `ps` when the spawns above run),
  because `ps` RSS leaves compressed pages out. The Needs-you item then says to run
  `sudo killall fseventsd` (about 15 seconds, no Mac restart). At start the hub also writes
  `.metadata_never_index` into the crew worktrees folder and the evidence folders so Spotlight
  stays out of them.
- A runaway `fseventsd` is restarted long before that stop. Healthy, it stays flat under crew
  work (5 to 13 MB through 100 to 230 runs a day, 13 to 18 November); in the stuck state seen on
  18 November it kept every event and grew 150 to 317 MB an hour. When it grows 150 MB within an
  hour, or holds 1 GB or more, the live hub (never a preview) restarts it at most once an hour
  with `sudo -n /usr/bin/killall fseventsd`, which works only with the sudoers rule below. At most
  once in 6 hours it first saves the process list and the fseventsd log to
  `<data dir>/diagnostics/fseventsd-*.txt` (the latest 10 are kept): read the one from the onset
  to find what tips it into that state. One operator alert is raised (as the machine-capacity
  stop is, after FLIGHT's triage window) when a restart fails, or when the hub has restarted it 3
  times in 6 hours, meaning restarting is not fixing the cause. Its text is not rewritten while it
  is open. It clears once the service is back under 150 MB with no recent run of restarts. While
  no browser is open and nothing waits to start, the hub does not read `fseventsd` and carries the
  last figure forward; only readings actually taken are judged (kept in the hub's memory, so after
  a hub restart the growth rule needs an hour of fresh readings again), so detection waits for the
  next fresh one. A restart that works clears the alert at
  once unless it is the third in 6 hours.
- The sudoers rule allows that one command only, for any program running as the operator. To add
  it, run once in Terminal (root writes it under a dotted name that sudo ignores, checks it, then
  moves it into place; the last step restarts it once without a password, as the hub will, and says so):
  `sudo sh -c 'umask 337; printf "%s ALL=(root) NOPASSWD: /usr/bin/killall fseventsd\n" "$1" > /etc/sudoers.d/.mc-fseventsd && visudo -cf /etc/sudoers.d/.mc-fseventsd && mv /etc/sudoers.d/.mc-fseventsd /etc/sudoers.d/mc-fseventsd' _ "$(whoami)" && sudo -k && sudo -n /usr/bin/killall fseventsd && echo "The hub can now restart it."`
- `load_window_min: 5` requires sustained load; `clear_after_min: 5` avoids start/stop churn.

The dashboard API's `/api/machine` response includes the latest disk and swap readings and a
`warning` string while admission is held. To test safely, temporarily set a floor above the
current reading, reload the hub configuration, and attempt a start. The start is held with the
measured reason. Send `force: true` only to confirm that an operator override can start it; the
override is recorded in the decision log. Remove the threshold override after the check. The
warning and start admission clear automatically after sustained headroom.
