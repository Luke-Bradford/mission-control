# Machine capacity admission

The hub samples disk free space, swap, memory-pressure free percentage and one-minute load. It
does not start a new writer run, review or FLIGHT `start_seat` request while capacity is tight;
work already running is left alone. A single `machine-capacity` Needs you item names the measured
condition and the tracked agent consumers. It closes after five minutes of headroom.

Configure the limits below `crew.machine_capacity` in `config.yaml` (all values have defaults):

- `disk_free_gb: 15` and `disk_free_pct: 5` block when either free-space floor is crossed.
- `swap_used_pct: 60` is measured against physical RAM, never the macOS swap-file size.
  `memory_free_pct: 10` independently detects pressure; swap alone always blocks above 90% of
  RAM. `load_per_core: 1.5` sets the other floor.
- `load_window_min: 5` requires sustained load; `clear_after_min: 5` avoids start/stop churn.

The dashboard API's `/api/machine` response includes the latest disk and swap readings and a
`warning` string while admission is held. To test safely, temporarily set a floor above the
current reading, reload the hub configuration, and attempt a start; remove the override after the
check. The warning and start admission clear automatically after sustained headroom.
