#!/usr/bin/env python3
"""Refresh a rotating, limited batch of fund performance estimates.

Adjusted historical prices can approximate annualized total return, but are NOT
current APY, seven-day yield, or SEC yield. Free-tier support varies by fund.
Retain all existing observations if an API response is missing or rate-limited.
"""
import datetime as dt
import json
import os
from pathlib import Path
import urllib.parse
import urllib.request
import time

PATH = Path("data/funds.json")
KEY = os.environ.get("ALPHAVANTAGE_API_KEY", "").strip()
if not KEY:
    print("ALPHAVANTAGE_API_KEY is not configured. No changes.")
    raise SystemExit(0)

data = json.loads(PATH.read_text())
funds = data["funds"]
n = len(funds)
if not n:
    raise SystemExit(0)

BATCH = 3  # well below the documented free daily quota
cursor = int(data.get("refresh_cursor", 0)) % n
updated = 0
attempted = 0
limited = False

def fetch(ticker):
    url = "https://www.alphavantage.co/query?" + urllib.parse.urlencode({
        "function": "TIME_SERIES_WEEKLY_ADJUSTED",
        "symbol": ticker,
        "apikey": KEY,
    })
    with urllib.request.urlopen(url, timeout=25) as result:
        return json.load(result)

for _ in range(min(BATCH, n)):
    fund = funds[cursor]
    symbol = fund["ticker"]
    # Avoid overwriting fund-reported metrics with adjusted-price estimates.
    # Stable-NAV money-market prices cannot estimate reinvested total returns.
    if fund.get("type") == "money_market" or "Yahoo Finance fund return fields" in fund.get("source", ""):
        print(symbol, "skipped: use issuer yield or Yahoo fund metrics")
        attempted += 1
        cursor = (cursor + 1) % n
        continue
    try:
        payload = fetch(symbol)
        series = payload.get("Weekly Adjusted Time Series")
        if not series:
            message = str(payload.get("Information") or payload.get("Note") or payload.get("Error Message") or "No usable adjusted data")
            print(symbol, "not updated:", message[:180])
            if "rate limit" in message.lower() or "requests" in message.lower() or "spreading out" in message.lower() or "standard api call frequency" in message.lower():
                limited = True
                break  # retry same ticker at next scheduled run
        else:
            prices = sorted(
                (dt.date.fromisoformat(day), float(item["5. adjusted close"]))
                for day, item in series.items()
                if float(item.get("5. adjusted close", 0)) > 0
            )
            if prices:
                end_date, end_price = prices[-1]
                returns = {}
                for years in (1, 3, 5):
                    target = end_date - dt.timedelta(days=round(years * 365.25))
                    candidates = [(date, price) for date, price in prices if abs((date - target).days) <= 35]
                    if candidates:
                        start_date, start_price = min(candidates, key=lambda pair: abs((pair[0] - target).days))
                        elapsed = (end_date - start_date).days / 365.25
                        if elapsed > 0:
                            returns[str(years) + "Y"] = round(((end_price / start_price) ** (1 / elapsed) - 1) * 100, 2)
                if returns:
                    fund["returns"] = returns
                    fund["asof"] = str(end_date)
                    fund["source"] = "Alpha Vantage weekly adjusted close (calculated annualized return)"
                    updated += 1
                    print(symbol, returns)
                else:
                    print(symbol, "insufficient history")
    except Exception as e:
        print(symbol, "request failed; previous data preserved:", str(e)[:180])
    attempted += 1
    cursor = (cursor + 1) % n
    if attempted < min(BATCH, n):
        time.sleep(2)

data["refresh_cursor"] = cursor
data["updated"] = str(dt.date.today()) if updated else data.get("updated")
PATH.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
print(f"Attempted {attempted}/{n}; refreshed {updated}; next index {cursor}; rate-limited: {limited}")
