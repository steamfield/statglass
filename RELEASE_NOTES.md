# StatGlass 0.7.0

StatGlass is a free, open-source system monitor for Apple Silicon Macs running macOS
26 or later.

This release makes charts, tables and Docker history behave the same way on every page,
and fixes a set of inconsistencies that had crept in between them. It also includes the
sortable tables from 0.6.2, which was never published.

## Sortable tables

- Every value column in the dashboard's tables sorts. The first click puts the largest
  values first, or sorts text from A to Z, and a second click flips the order. Missing
  readings always sort to the bottom, and summary rows such as **Other apps** stay last.
- Live tables keep their order while the pointer is over them, and now also while you move
  through them with the keyboard. A mouse click no longer freezes the order after the
  pointer leaves.
- Containers can be grouped by project from the **View** menu, with groups you can collapse.

## Charts

- Module history charts share one look: values in a left gutter and five time ticks. Swap
  and Used memory gain gutter values, Battery gains a percent grid, and Swap gains a
  selection summary.
- One crosshair and tooltip on every chart, and the same wording for averages ("10 s avg").
- The popover's network and power charts no longer rescale every second, and Disk I/O's
  time axis ends at "now" like the rest.
- **Show as table** for Timeline lanes and container comparisons is one sortable table with
  min, average and max per series and gaps listed in place.
- Screen reader descriptions of live charts change at most every 10 seconds.

## Docker history

- A container whose stats can't be read only breaks its own line; other containers and the
  engine total are unaffected, and **History details** says what was missed.
- Waking the Mac from sleep is no longer recorded as a clock change.
- History stays readable however many interruptions a container records. The history
  database upgrades itself on first launch; an older StatGlass can't open it afterwards.

## Smaller changes

- Confirmations for hosts, updates and cleanup no longer close on a stray click or Escape
  while their action runs.
- Pages explain a missing module with the host's own name instead of "this Mac".
- Disk processes search matches PIDs and ports by their leading digits, like Processes.
- The battery hours view, superseded by Battery's range history, is gone.

## Moving from Kelvo

StatGlass was called Kelvo before 0.4.0. Kelvo does not update to StatGlass
automatically: install StatGlass from the DMG below, then add your remote hosts again
from **Add host**. Kelvo's settings and history are not imported.
