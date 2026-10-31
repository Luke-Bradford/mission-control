# Machine capacity admission

The hub samples disk free space, swap, memory-pressure free percentage and one-minute load. It
does not start a new writer run, review or FLIGHT `start_seat` request while capacity is tight;
work already running is left alone. A single `machine-capacity` Needs you item names the measured
condition and the tracked agent consumers. It closes after five minutes of headroom.

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
- `load_window_min: 5` requires sustained load; `clear_after_min: 5` avoids start/stop churn.

The dashboard API's `/api/machine` response includes the latest disk and swap readings and a
`warning` string while admission is held. To test safely, temporarily set a floor above the
current reading, reload the hub configuration, and attempt a start. The start is held with the
measured reason. Send `force: true` only to confirm that an operator override can start it; the
override is recorded in the decision log. Remove the threshold override after the check. The
warning and start admission clear automatically after sustained headroom.
