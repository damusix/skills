# Phase 2: Generate Scenarios

## 2.1 Run scenario generation

Generate scenarios from the tile:
```bash
tessl scenario generate <tile-path> --count=<N>
```

Default to `--count=3` for a first run, up to 5 for comprehensive coverage. For example:
```bash
tessl scenario generate ./my-tile --count=3
```

The CLI polls until complete (~1–2 minutes per scenario). Capture the **run ID** from the output — you'll need it for the download step.

> "Scenario generation typically takes 1–2 minutes per scenario. I'll wait for it to complete."

## 2.2 Review what was generated

After generation completes, the CLI shows the generated scenarios. Summarize for the user:
- Number of scenarios generated
- Scenario names/slugs

Ask: **"These look good? Want me to download them and proceed, or should I regenerate?"**
