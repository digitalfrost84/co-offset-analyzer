# Ryzen CO Offset Analyzer

A single-file browser tool for estimating per-core AMD Ryzen Curve Optimizer offsets from HWiNFO64 CSV logs.

The analyzer runs entirely in your browser. CSV data is processed locally and is not uploaded anywhere.

## Features

- Reads HWiNFO64 CSV logs from file upload or pasted text
- Auto-detects core count from `Core N VID [V]` columns
- Auto-detects CCD groups when HWiNFO exposes `CoreN (CCDx)` temperature columns
- Supports whole-CPU or per-CCD analysis scopes
- Produces copy-friendly per-core CO recommendations
- Works offline as a standalone `index.html`

## Quick Start

1. Open `index.html` in a modern browser.
2. Upload or paste a HWiNFO64 CSV log.
3. Review the recommended per-core offsets.
4. Stability-test carefully before applying values in BIOS or tuning software.

## Beginner Iteration Guide

This tool does not apply CO offsets by itself. It only helps you decide what to try next.

The basic loop is:

1. Start with all current CO offsets set to `0`.
2. Start HWiNFO64 logging.
3. Run a heavy all-core workload long enough to collect useful data.
4. Stop HWiNFO64 logging.
5. Load the CSV into this analyzer.
6. Apply the recommended offsets in BIOS, SMUDebugTool, or your preferred tuning tool.
7. Click `Use` in the analyzer so the recommended offsets become the new current offsets.
8. Start a new HWiNFO64 log with those offsets applied.
9. Run the workload again.
10. Load the new CSV and repeat.

Do not keep appending to the same HWiNFO64 log between iterations. Stop logging and start a fresh log after applying new offsets, so each CSV represents exactly one offset set.

### When To Stop

You are usually close enough when:

- VID correlation is high, roughly `0.95` or better.
- VID spread is low, roughly a few mV.
- Most recommendations say `no change`.
- Remaining recommendations are only `+1` or `-1` and do not repeat consistently.

Tiny one-step changes can be measurement noise. If a core asks for the same one-step change across multiple fresh logs, it is more likely worth applying.

### Conservative Iteration

If you want fewer iterations:

1. Apply the first recommendation from `0`.
2. On later passes, ignore one-step changes unless the same core repeats the same direction.
3. Stop tuning and begin stability testing once the tool mostly recommends no change.

## HWiNFO64 Logging Tips

For best results, log while running a heavy all-core workload. The CSV should include:

- `CPU Core Current (SVI3 TFN) [A]`
- `Core 0 VID [V]`, `Core 1 VID [V]`, and so on
- Optional but useful for multi-CCD CPUs: `Core0 (CCD1) [C]`, `Core8 (CCD2) [C]`, or equivalent CCD temperature columns

If too few rows pass the current threshold, lower the threshold or collect a longer/heavier workload log.

## How Recommendations Are Calculated

The tool filters log rows by CPU core current, calculates the average VID for each core, then compares each core against a reference mean:

- `Auto CCD`: each core is compared against its detected CCD mean when possible
- `Whole CPU`: each core is compared against the global CPU mean

The VID delta is converted into CO steps using the configured mV-per-step value, then added to your current offsets.

## Safety Notes

These recommendations are a starting point, not a guarantee of stability.

- Apply changes gradually.
- Test with multiple workloads.
- Watch for idle crashes, WHEA errors, game crashes, and sleep/resume issues.
- Keep notes so you can revert quickly.

## License

Noncommercial use is licensed under the PolyForm Noncommercial License 1.0.0. See `LICENSE`.

Commercial use requires a separate commercial license from the author.
