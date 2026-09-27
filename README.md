# Distribution Feeder Outage Simulator

A small interactive model of a radial power distribution feeder: one substation
feeding a main trunk with three lateral branches, each serving two customers,
plus a backup tie switch. Click a line to fault it and watch the outage cascade
downstream; close the tie switch to restore isolated customers from a different
branch.

## Running it

No build step, no dependencies. Just open `index.html` in a browser, or in
VS Code right-click `index.html` -> "Open with Live Server" if you have that
extension installed (recommended so changes auto-refresh as you edit).

## Files

- `index.html` - page structure
- `style.css` - all styling (dark control-room theme)
- `script.js` - the graph model, fault/restoration logic, and SVG rendering

## Ideas for next passes

- Add a fault event log panel (timestamped list of faults/restorations)
- Add a second tie switch for a richer restoration scenario
- Add a "protection zone" concept: faulting a segment near the substation
  should trip a breaker further upstream than one right next to a customer
- Persist state so a reload doesn't reset the feeder
