# Fidelity UTMA Investment Planner

A standalone, installable contribution planner for a child's Fidelity UTMA account. Choose a strategy, adjust fund weights and hypothetical return assumptions, enter an irregular deposit, and copy exact purchase amounts. Includes kid-friendly investing explanations and a stock-risk simulator.

This is an educational allocation calculator, **not** connected to Fidelity and not investment advice. Investment yields and historical returns are not guaranteed APYs. Refresh estimates against fund issuer disclosures before relying on them.

## GitHub Pages

Settings → Pages → Deploy from a branch → `main` → `/ (root)` → Save.

Expected website address: https://consultdibona.github.io/Fidelity-Investment-Calculator/

Install from the browser menu after Pages is live. All preferences are stored locally in the current browser and are not uploaded or synced.


## Market data refresh

- `scripts/refresh_yahoo.py`: Weekly, keyless Yahoo Finance lookup using documented `Ticker.get_info()` and `Ticker.history(start=..., interval="1d", auto_adjust=False, actions=True, repair=True)`. The resulting `Adj Close` accounts for price changes, splits and distributions. This generates **estimated historical total returns**, not issuer-verified performance.
- `scripts/test_yahoo_returns.py`: Regression tests that run before the Yahoo refresh, including reinvestment-consistent price returns, YTD handling and money-market safety checks.
- `scripts/refresh_funds.py`: Optional Alpha Vantage fallback that preserves Yahoo/issuer values and uses the `ALPHAVANTAGE_API_KEY` GitHub Actions secret.
- Individual figures are documented in `data/funds.json` under `return_details`. The `returns` values are percentages (e.g. `6.15` means 6.15%). YTD is **not annualized**; 3Y and 5Y are annualized.
- FDLXX and other stable-price money market funds must **not** have historical total returns inferred from stable NAV changes. Use the fund provider's yield and total-return reporting, with an as-of date.
- A 7-day yield is not an APY or promised future return. SEC yield, distribution yield and historical total return are different measures. The projection assumptions are editable and intentionally independent.
- Yahoo `get_info()` fields are optional, Yahoo APIs may be rate-limited, and the website's detailed performance table is not fully available through the `funds_data` accessor. A missing return stays missing or retains its prior labeled source.
- Yahoo Finance data is subject to Yahoo's terms and the yfinance project's personal-use caveat. This repository is an educational personal planner, not a licensed market-data redistribution service.

Run the Yahoo workflow manually at `Actions -> Refresh Yahoo fund metrics -> Run workflow`, or let its weekly schedule update the cached catalog. GitHub Pages deploys the updated JSON after GitHub Actions commits it.
