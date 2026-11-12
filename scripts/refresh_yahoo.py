#!/usr/bin/env python3
"""Try Yahoo Finance's fund-level metrics. No historical-price fallback.

Yahoo's displayed fund performance table is not fully implemented in
yfinance.funds_data. Collect available Ticker.info fields only, and keep data
as missing when not supplied. Intended for the owner's personal research.
"""
from datetime import datetime, timezone
import json
from pathlib import Path
import time
import yfinance as yf

path = Path("data/funds.json")
payload = json.loads(path.read_text(encoding="utf-8"))
priority = {"FDLXX", "FZROX", "IBDU", "FCNVX", "FXAIX"}
today = datetime.now(timezone.utc).date().isoformat()
changed = 0

def percentage(raw):
    if raw is None or isinstance(raw, bool):
        return None
    try:
        v = float(raw)
    except (TypeError, ValueError):
        return None
    if not (-1 <= v <= 5):
        return None
    return round(v * 100, 2)

for fund in payload.get("funds", []):
    symbol = fund.get("ticker")
    if symbol not in priority:
        continue
    try:
        info = yf.Ticker(symbol).get_info() or {}
        metrics = {}
        for period, field in (
            ("YTD", "ytdReturn"),
            ("3Y", "threeYearAverageReturn"),
            ("5Y", "fiveYearAverageReturn"),
        ):
            value = percentage(info.get(field))
            if value is not None:
                metrics[period] = value
        # Yahoo's one-year stock price performance is NOT a mutual fund's
        # annualized total return. Do not map oneYearReturn here.
        if fund.get("type") == "money_market":
            # A stable $1 NAV does not describe money-market total return.
            fund["returns"] = {}
            fund.pop("asof", None)
            fund["source"] = "Yahoo Finance 7-day yield only; official total returns not loaded"
        if metrics and fund.get("type") != "money_market":
            fund["returns"] = metrics
            fund["asof"] = today
            fund["source"] = "Yahoo Finance fund return fields via yfinance (retrieved " + today + ")"
            changed += 1
        # 'yield' is ambiguous for ETFs. Never equate it with SEC yield.
        # A Yahoo money-market sevenDayYield, if present, is distinct.
        if fund.get("type") == "money_market":
            seven = percentage(info.get("sevenDayYield"))
            if seven is not None:
                fund["yield"] = {
                    "value": seven, "type": "7-day yield",
                    "asof": today, "source": "Yahoo Finance (retrieval date; quote date not supplied)"
                }
                changed += 1
        print(symbol, "fund metrics:", metrics or "none", "7-day yield:", fund.get("yield"))
    except Exception as exc:
        print(symbol, "Yahoo lookup unavailable; previously known metrics retained:", str(exc)[:180])
    time.sleep(2)

payload["yahoo_checked"] = today
path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
print("Yahoo metrics updated for", changed, "entries")
