#!/usr/bin/env python3
"""Refresh annualized total returns from adjusted weekly market data when available.
Uses optional ALPHAVANTAGE_API_KEY from GitHub Actions Secrets.
No fabricated quotes and no use of unadjusted prices as total returns.
"""
import datetime as dt
import json
import os
import pathlib
import time
import urllib.parse
import urllib.request

PATH = pathlib.Path("data/funds.json")
KEY = os.environ.get("ALPHAVANTAGE_API_KEY", "").strip()
if not KEY:
    print("No ALPHAVANTAGE_API_KEY secret configured; keeping catalog unchanged.")
    raise SystemExit(0)

data = json.loads(PATH.read_text())
today = dt.date.today()
updated_count = 0

def request(ticker):
    q = urllib.parse.urlencode({
        "function": "TIME_SERIES_WEEKLY_ADJUSTED",
        "symbol": ticker,
        "apikey": KEY,
    })
    with urllib.request.urlopen("https://www.alphavantage.co/query?" + q, timeout=30) as r:
        return json.load(r)

for idx, fund in enumerate(data["funds"][:20]):
    ticker = fund["ticker"]
    try:
        payload = request(ticker)
        series = payload.get("Weekly Adjusted Time Series", {})
        if not series:
            print(ticker, "No adjusted series:", str(payload.get("Information") or payload.get("Note") or payload.get("Error Message") or "unsupported")[:160])
            continue
        points = sorted(
            (dt.date.fromisoformat(day), float(v["5. adjusted close"]))
            for day, v in series.items()
            if float(v.get("5. adjusted close", 0)) > 0
        )
        if not points:
            continue
        latest_date, latest_price = points[-1]
        returns = {}
        for n in (1, 3, 5):
            target = latest_date - dt.timedelta(days=round(n * 365.25))
            candidates = [(day, price) for day, price in points if abs((day - target).days) <= 35]
            if not candidates:
                continue
            earlier, base = min(candidates, key=lambda x: abs((x[0] - target).days))
            span = (latest_date - earlier).days / 365.25
            if span <= 0:
                continue
            returns[str(n) + "Y"] = round(((latest_price / base) ** (1 / span) - 1) * 100, 2)
        if returns:
            fund["returns"] = returns
            fund["asof"] = str(latest_date)
            fund["source"] = "Alpha Vantage weekly adjusted close, annualized total return estimate"
            updated_count += 1
            print(ticker, returns)
    except Exception as exc:
        print(ticker, "refresh failed:", str(exc)[:160])
    if idx < min(len(data["funds"]), 20) - 1:
        time.sleep(13)

if updated_count:
    data["updated"] = str(today)
    PATH.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
    print("Updated", updated_count, "funds")
else:
    print("No usable adjusted return data. No catalog change.")
