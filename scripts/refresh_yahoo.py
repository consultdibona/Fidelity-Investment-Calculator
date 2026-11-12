#!/usr/bin/env python3
"""Refresh Yahoo fund fields and dividend-adjusted price-derived returns.

Ticker.get_info fields are optional. Yahoo adjusted-price performance is an
estimate, not issuer-published total return. Never infer a money market fund's
investment return from its stable $1 NAV. Missing data is not replaced.
"""
from datetime import date, datetime, timedelta, timezone
import json
import math
from pathlib import Path
import time

CATALOG = Path('data/funds.json')
CORE = {'FDLXX', 'FZROX', 'IBDU', 'FCNVX', 'FXAIX'}


def fraction_to_percent(raw):
    """Convert annualized decimal-fraction fields, not ambiguous percent units."""
    if raw is None or isinstance(raw, bool):
        return None
    try:
        v = float(raw)
    except (ValueError, TypeError):
        return None
    if not math.isfinite(v) or not -1 < v < 1:
        return None
    return round(100.0 * v, 2)


def calculate_adjusted_returns(observations):
    """Use adjusted-close prices for reinvestment-consistent returns.

    Select nearest price within 10 days of anniversary; use previous year's
    last closing price for YTD. Distributions are already adjusted into prices.
    """
    prices = []
    for day, raw in observations:
        if hasattr(day, 'date'):
            day = day.date()
        try:
            value = float(raw)
        except (ValueError, TypeError):
            continue
        if isinstance(day, date) and math.isfinite(value) and value > 0:
            prices.append((day, value))
    prices.sort(key=lambda x: x[0])
    if len(prices) < 20:
        return {}, None
    end, latest = prices[-1]
    returns = {}
    for years in (1, 3, 5):
        target = end - timedelta(days=round(years * 365.25))
        nearby = [(d, p) for d, p in prices if abs((d - target).days) <= 10]
        if not nearby:
            continue
        start, initial = min(nearby, key=lambda x: abs((x[0] - target).days))
        elapsed = (end - start).days / 365.25
        if elapsed <= 0:
            continue
        value = ((latest / initial) ** (1 / elapsed) - 1) * 100
        if math.isfinite(value) and -100 < value < 200:
            returns[f'{years}Y'] = round(value, 2)
    last_year_end = date(end.year - 1, 12, 31)
    starts = [(d, p) for d, p in prices if d <= last_year_end and (last_year_end - d).days <= 10]
    if starts:
        start, initial = starts[-1]
        value = (latest / initial - 1) * 100
        if math.isfinite(value) and -100 < value < 200:
            returns['YTD'] = round(value, 2)
    return returns, end.isoformat()


def select_fund_returns(fund, info, calculated, asof, retrieved):
    """Preserve old data on failures; prefer consistent Yahoo fund-level fields."""
    if fund.get('type') == 'money_market':
        fund['returns'] = {}
        fund['return_details'] = {}
        fund.pop('asof', None)
        fund['source'] = 'Money market: use seven-day yield or issuer total returns'
        return 0

    existing = fund.get('returns') or {}
    details = fund.get('return_details') or {}
    for term in existing:
        if term not in details:
            details[term] = {'source': fund.get('source', 'Previous data'), 'asof': fund.get('asof')}
    new = {}
    for term, value in calculated.items():
        new[term] = (value, {
            'source': 'Yahoo Finance dividend-adjusted history (calculated)',
            'method': 'adjusted_close_ratio', 'asof': asof,
        })
    # These optional 3Y/5Y info fields are decimal fractions, but Yahoo does
    # not publish a reliable field date here. Do NOT import ytdReturn.
    for term, field in (('3Y', 'threeYearAverageReturn'), ('5Y', 'fiveYearAverageReturn')):
        reported = fraction_to_percent(info.get(field))
        if reported is None:
            continue
        if term in new and abs(new[term][0] - reported) > 2.0:
            print(f"{fund['ticker']} {term}: reported {reported}% differs from price-derived {new[term][0]}%; using derived result")
            continue
        new[term] = (reported, {
            'source': f'Yahoo Finance fund info: {field}',
            'method': 'reported_yahoo_field', 'asof': None,
            'retrieved': retrieved,
        })
    for term, (value, meta) in new.items():
        existing[term] = value
        details[term] = meta
    if new:
        fund['returns'] = existing
        fund['return_details'] = details
        fund['asof'] = asof or fund.get('asof')
        fund['source'] = 'Mixed historical sources; see return_details by period'
    return len(new)


def refresh(path=CATALOG):
    import yfinance as yf
    payload = json.loads(path.read_text(encoding='utf-8'))
    today = datetime.now(timezone.utc).date()
    retrieved = today.isoformat()
    updates = 0
    for fund in payload.get('funds', []):
        symbol = fund.get('ticker')
        if symbol not in CORE:
            continue
        print(f'Fetching {symbol}')
        ticker = yf.Ticker(symbol)
        info = {}
        try:
            info = ticker.get_info() or {}
        except Exception as exc:
            print(symbol, 'info unavailable:', str(exc)[:140])
        computed, history_asof = {}, None
        if fund.get('type') != 'money_market':
            try:
                history = ticker.history(
                    start=(today - timedelta(days=6 * 366)).isoformat(),
                    interval='1d', auto_adjust=False, actions=True, repair=True,
                )
                if history is not None and not history.empty and 'Adj Close' in history:
                    computed, history_asof = calculate_adjusted_returns(history['Adj Close'].items())
                else:
                    print(symbol, 'no dividend-adjusted history available')
            except Exception as exc:
                print(symbol, 'history unavailable:', str(exc)[:140])
        updates += select_fund_returns(fund, info, computed, history_asof, retrieved)
        # Never substitute ambiguous Yahoo 'yield' for seven-day or SEC yield.
        if fund.get('type') == 'money_market':
            seven = fraction_to_percent(info.get('sevenDayYield'))
            if seven is not None and 0 <= seven <= 20:
                fund['yield'] = {
                    'value': seven, 'type': '7-day yield',
                    'asof': 'Not provided', 'retrieved': retrieved,
                    'source': 'Yahoo Finance info.sevenDayYield (quote date unverified)',
                }
                updates += 1
        print(symbol, 'returns:', fund.get('returns'), 'yield:', fund.get('yield'))
        time.sleep(2)
    payload['yahoo_checked'] = retrieved
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    print('Fund metrics updated:', updates)


if __name__ == '__main__':
    refresh()
