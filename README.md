# Ryzen CO Offset Analyzer

A single-file browser tool for producing per-core AMD Ryzen Curve Optimizer recommendations from HWiNFO64 CSV logs.

The analyzer runs entirely in your browser. CSV data is processed locally and is not uploaded anywhere.

`index.html` is the current interface. To keep a local copy, download [`index.html`](https://raw.githubusercontent.com/digitalfrost84/co-offset-analyzer/main/index.html) together with [`v2.css`](https://raw.githubusercontent.com/digitalfrost84/co-offset-analyzer/main/v2.css) into the same folder.

## Features

- Reads HWiNFO64 CSV logs from file upload or pasted text
- Auto-detects core count from `Core N VID [V]` columns
- Auto-detects CCD groups when HWiNFO exposes `CoreN (CCDx)` temperature columns
- Supports whole-CPU or per-CCD analysis scopes
- Produces copy-friendly per-core CO recommendations
- Leaves low-VID cores unchanged and maps each high-side residual to all complete configured CO steps
- Flags probable per-core clock stretching from reported-vs-effective clock gaps
- Works offline as a standalone `index.html`

## Quick Start

1. Open `index.html` in a modern browser.
2. Upload or paste a HWiNFO64 CSV log.
3. Review the experimental per-core trial offsets.
4. Stability-test carefully before and after applying values in BIOS or tuning software.

## Beginner Iteration Guide

This tool does not apply CO offsets by itself. It only helps you decide what to try next.

The basic loop is:

1. Start with all current CO offsets set to `0`.
2. Start HWiNFO64 logging.
3. Run a heavy all-core workload long enough to collect useful data.
4. Stop HWiNFO64 logging.
5. Load the CSV into this analyzer.
6. Apply only the trial offsets you intend to test in BIOS, SMUDebugTool, or your preferred tuning tool.
7. After validation, click `Use` so those trial offsets become the analyzer's new current offsets.
8. Start a new HWiNFO64 log with those offsets applied.
9. Run the workload again.
10. Load the new CSV and repeat.

Do not keep appending to the same HWiNFO64 log between iterations. Stop logging and start a fresh log after applying new offsets, so each CSV represents exactly one offset set.

### When To Stop

Stop requesting more VID-alignment trials when:

- No high-side VID residual exceeds the configured step estimate.
- A requested direction does not repeat across fresh, matched-condition logs.
- Performance, power, temperature, clock stretching, or stability gets worse.

VID co-movement/correlation is workload context only. It does not show that per-core curves are aligned and is not a convergence target.

Tiny one-step changes can be measurement noise. A direction that repeats across multiple fresh logs collected under the same conditions is more credible, but still requires stability testing.

### Applying A Recommendation

For a direct recommendation:

1. Apply the calculated offsets from `0`.
2. Ignore one-step changes unless the same core repeats the same direction in a fresh matched log.
3. Stop the VID-alignment experiment when the tool shows no high-side movement, then perform separate stability testing.

## HWiNFO64 Logging Tips

For best results, log while running a heavy all-core workload. The CSV should include:

- `CPU Core Current (SVI3 TFN) [A]`
- `CPU VDDCR_VDD Voltage (SVI3 TFN) [V]` for shared-rail context
- `Core 0 VID [V]`, `Core 1 VID [V]`, and so on
- Optional but useful for multi-CCD CPUs: `Core0 (CCD1) [C]`, `Core8 (CCD2) [C]`, or equivalent CCD temperature columns

Localized HWiNFO64 sensor names are supported. The analyzer prefers stable parts of the header such as units, `VID`, `SVI3`, `VDDCR_VDD`, per-core indexes, `T0`/`T1`, and `CCD` tags, then uses language-specific words only as ranking hints. If direct rail current is missing, it can use SVI3 core-rail power divided by VDD voltage as a coarse load-selection proxy only.

By default, the analyzer auto-selects a load threshold from the log. When CPU usage data is available, it uses the high-usage plateau to find the matching current range. Otherwise, it falls back to the high-current distribution. This is meant to keep rows where the CPU is under enough load for vdroop and load-line behavior to matter, while skipping idle and light-load samples. If auto mode says the log never reached a useful load range, collect a heavier workload log or switch to manual current only when you know the expected current range.

## Clock Stretching Check

When HWiNFO64 includes both reported core clocks and effective clocks, the analyzer adds a clock stretching table. It compares each busy core's reported clock against its effective clock on the same filtered rows used for VID analysis.

This is a warning signal, not an automatic CO correction. A core is suspicious when its reported clock stays high but its effective clock falls meaningfully behind while the core is active. A suspect result suppresses trial changes from that log; verify with another workload or reduce negative CO manually on the suspect cores.

## What This Heuristic Can and Cannot Tell You

Core VID is a voltage request produced by AMD's adaptive voltage/frequency control, not a measurement of voltage delivered to an individual core. SenseMI/SMU decisions also reflect the core's fused curve, activity, frequency, temperature, and platform limits. Different per-core VIDs can therefore be normal; making their averages closer does not prove equal silicon quality, voltage margin, performance, or stability.

HWiNFO's SVI3 TFN VDDCR_VDD voltage, current, and power describe the shared CPU core rail (all cores), not separate per-core rails. This analyzer uses that telemetry only to identify a comparable loaded part of the log. Power divided by voltage is a coarse current proxy when direct rail-current telemetry is absent.

Load-line calibration changes steady-state droop and transient behavior. Keep LLC, BIOS/AGESA, PBO/scalar and power limits, workload, cooling, and ambient conditions unchanged between comparison logs. CSV-rate SVI3 TFN samples - and especially a motherboard Vcore channel - cannot characterize fast overshoot/undershoot or establish that an LLC level or CO value is safe.

## How Trial Offsets Are Calculated

The tool keeps rows with complete plausible VIDs at the selected loaded operating range, calculates the average VID for each core, then compares each core against a robust group-median baseline:

- `Auto CCD`: each core is compared against its detected CCD median when possible
- `Whole CPU`: each core is compared against the whole-CPU median

The median prevents one unusually low request from pulling an entire CCD toward a low SenseMI state; a lone high requester still stands above the baseline.

Only high-side residuals produce automatic movement. A repeatedly high requesting core can be a shared-rail bottleneck under a tightly controlled all-core workload, but SenseMI may spend a successful CO change on more frequency instead of lower rail voltage.

The recommendation logic is:

- If the maximum high-side VID residual is below the configured step estimate, current offsets are preserved.
- Each core must clear one full configured step; fractional steps are not rounded up.
- Low-VID cores are left unchanged; their CO is not relaxed from VID alone.
- A high-side residual is converted to every complete configured CO step, up to the supported CO range.
- Existing positive offsets are preserved unless a high-side trial moves them downward; the analyzer never creates or increases a positive offset.

The mV-per-step setting is an empirical response estimate used as a deadband and scale. AMD documents CO as a curve shift but does not guarantee one fixed mV conversion across cores, frequencies, or temperatures. Calibrate it from controlled before/after logs when possible.

## Safety Notes

These trial directions are a starting point for an experiment, not evidence or a guarantee of stability.

- Apply changes gradually.
- Test with multiple workloads.
- Watch for idle crashes, WHEA errors, game crashes, and sleep/resume issues.
- Keep notes so you can revert quickly.

## License

Noncommercial use is licensed under the PolyForm Noncommercial License 1.0.0. See `LICENSE`.

Commercial use requires a separate commercial license from the author.
