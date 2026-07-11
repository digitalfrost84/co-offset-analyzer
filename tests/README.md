# Regression Fixtures

These CSV logs cover the HWiNFO64 formats that have broken the analyzer before:

- `bench_for_CO_Offset_Analyzer.CSV`: German labels with comma-separated rows and decimal-comma numbers.
- `hohohaha_deutsch.CSV`: German direct `CPU-Kernstrom (SVI3 TFN)` current logging.
- `hwinfo_16core_deutsch.csv`: German 16-core log without direct core current, using SVI3 power / VDD estimated current.
- `hohohaha6-large.csv`: Reduced high-row-count reproduction of `hohohaha6.CSV`, covering whole-log limit-headroom calculations without committing the original 414 MB log.

Run the regression suite from the repository root:

```powershell
node tests/scripts/regression.js
```

Refresh snapshots after an intentional analyzer behavior change:

```powershell
node tests/scripts/regression.js --update
```
