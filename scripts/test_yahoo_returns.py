"""Offline regression tests for the Yahoo refresh calculations."""
import datetime as dt
import unittest
from refresh_yahoo import calculate_adjusted_returns, fraction_to_percent, select_fund_returns


class YahooMetricsTests(unittest.TestCase):
    def test_fraction_safe(self):
        self.assertEqual(fraction_to_percent(.0615), 6.15)
        self.assertIsNone(fraction_to_percent(1.101))
        self.assertIsNone(fraction_to_percent(True))

    def test_adjusted_history_and_ytd(self):
        prices = [(dt.date(y, 11, 12), 100 * 1.1 ** (y - 2021))
                  for y in range(2021, 2027)]
        prices.append((dt.date(2025, 12, 31), 151.0))
        for day in range(1, 22):
            prices.append((dt.date(2026, 10, day), 160.0))
        result, asof = calculate_adjusted_returns(prices)
        self.assertEqual(asof, '2026-11-12')
        self.assertAlmostEqual(result['1Y'], 10.0, places=1)
        self.assertAlmostEqual(result['3Y'], 10.0, places=1)
        self.assertAlmostEqual(result['5Y'], 10.0, places=1)
        self.assertAlmostEqual(result['YTD'], 6.66, places=1)

    def test_no_stable_nav_total_return(self):
        fund = {'ticker': 'FDLXX', 'type': 'money_market',
                'returns': {'1Y': 0.0}, 'source': 'previous'}
        select_fund_returns(fund, {}, {'1Y': 0.0, 'YTD': 0.0},
                            '2026-11-12', '2026-11-12')
        self.assertEqual(fund['returns'], {})

    def test_reported_return_and_source_preservation(self):
        fund = {'ticker': 'IBDU', 'type': 'bond_etf',
                'returns': {'1Y': 1.9}, 'source': 'Alpha Vantage',
                'asof': '2026-11-11'}
        count = select_fund_returns(
            fund, {'threeYearAverageReturn': .0615, 'fiveYearAverageReturn': .0118},
            {'3Y': 6.14, '5Y': 1.20, 'YTD': 3.1},
            '2026-11-11', '2026-11-12')
        self.assertEqual(count, 3)
        self.assertEqual(fund['returns']['1Y'], 1.9)
        self.assertEqual(fund['returns']['3Y'], 6.15)
        self.assertEqual(fund['returns']['5Y'], 1.18)
        self.assertEqual(fund['return_details']['1Y']['source'], 'Alpha Vantage')

    def test_invalid_ytd_info_not_ingested(self):
        fund = {'ticker': 'FCNVX', 'type': 'bond_mutual_fund',
                'returns': {}}
        select_fund_returns(fund, {'ytdReturn': 3.0817},
                            {}, None, '2026-11-12')
        self.assertNotIn('YTD', fund['returns'])


if __name__ == '__main__':
    unittest.main()
