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
