# Ryzen CO Offset Analyzer

A single-file browser tool for producing per-core AMD Ryzen Curve Optimizer recommendations from HWiNFO64 CSV logs.

The analyzer runs entirely in your browser. CSV data is processed locally and is not uploaded anywhere.

`index.html` is the current V2 interface. The historical V1 interface is available as [`index-v1.html`](https://raw.githubusercontent.com/digitalfrost84/co-offset-analyzer/main/index-v1.html), and both interfaces use the same harmonization engine. To keep V2 locally, download `index.html` together with `v2.css` into the same folder.

The harmonizer targets the relative per-core VID requests observed during the same loaded samples. It predicts how each legal whole-step CO move changes the residual field, then selects the fewest core changes that can bring each CPU/CCD group inside the configured mV-per-step target. A small hysteresis margin prevents dots sitting only just beyond a guide from starting another correction pass.

## Features

- Reads HWiNFO64 CSV logs from file upload or pasted text
- Auto-detects core count from `Core N VID [V]` columns
- Auto-detects CCD groups when HWiNFO exposes `CoreN (CCDx)` temperature columns
- Supports whole-CPU or per-CCD analysis scopes
- Produces copy-friendly per-core CO recommendations
- Uses one shared, bidirectional, offset-aware harmonization engine in V1 and V2
- Flags probable per-core clock stretching from reported-vs-effective clock gaps
- Works offline as a standalone `index.html`

## Quick Start

1. Open `index.html` in a modern browser.
2. Upload or paste a HWiNFO64 CSV log.
3. Enter the CO offsets that were active while the log was recorded, then review the complete recommended profile.
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

- The tool reports that the residual field is within the configured target or its hysteresis band.
- A requested direction does not repeat across fresh, matched-condition logs.
- Performance, power, temperature, clock stretching, or stability gets worse.

VID co-movement/correlation is workload context only. It does not show that per-core curves are aligned and is not a convergence target.

Tiny one-step changes can be measurement noise. A direction that repeats across multiple fresh logs collected under the same conditions is more credible, but still requires stability testing.

### Applying A Recommendation

For a direct recommendation:

1. Apply the complete calculated profile shown by the tool.
2. Ignore one-step changes unless the same core repeats the same direction in a fresh matched log.
3. Stop the VID-alignment experiment when the tool shows no harmonization movement, then perform separate stability testing.

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

The tool keeps rows with complete plausible VIDs at the selected loaded operating range, calculates the average VID for each core, then compares each core against the original V1 arithmetic group-mean baseline:

- `Auto CCD`: each core is compared against its detected CCD mean when possible
- `Whole CPU`: each core is compared against the whole-CPU mean

Residuals produce relative movement in both directions. A high-requesting core can move more negative; a low-requesting core with an existing negative offset can move less negative. The analyzer predicts each move in whole CO steps and never recommends values outside `-50` through `0`. SenseMI may spend a successful CO change on voltage, frequency, or both, so every applied profile still requires a fresh measurement.

The recommendation logic is:

- Each CPU/CCD group is optimized independently.
- The yellow guides show half of the configured mV-per-step estimate around zero.
- A core becomes movable only after clearing its guide by the hysteresis margin; a group also needs to clear the target spread by that margin.
- The engine evaluates predicted whole-step outcomes and chooses the smallest sufficient set of changed cores, then the fewest total CO steps.
- If an extreme core is pinned at `0` or `-50`, the engine can rebase the other cores together instead of repeatedly chasing the blocked core.
- If the bounds still make the target impossible, it chooses the tightest attainable residual field instead of changing one arbitrary outlier at a time.
- High-side residuals move more negative, while low-side residuals may relax an existing negative offset toward zero.

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
