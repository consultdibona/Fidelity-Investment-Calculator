#!/usr/bin/env node
/**
 * Retrieve Yahoo's fundPerformance table using yahoo-finance2.
 *
 * Prefer Yahoo's fund-reported performance over estimates derived from
 * adjusted prices. Do not infer money market returns from a $1 share price.
 * Keep the existing catalog untouched if the module is blocked/unavailable.
 */
import fs from "node:fs";

const PATH = "data/funds.json";
const CORE = new Set(["FDLXX", "FZROX", "IBDU", "FCNVX", "FXAIX"]);

export function parseRatio(raw) {
  // The unvalidated Yahoo response may wrap numbers as {raw, fmt}.
  if (raw && typeof raw === "object" && !(raw instanceof Date)) raw = raw.raw;
  // fundPerformance uses decimal fractions (0.12 = 12%).
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= -1 || raw >= 1) return null;
  const percent = +(raw * 100).toFixed(2);
  return percent > -100 && percent < 100 ? percent : null;
}

export function parseAsOfDate(raw) {
  if (raw && typeof raw === "object" && !(raw instanceof Date)) raw = raw.raw ?? raw.fmt;
  let date = null;
  if (raw instanceof Date) date = raw;
  else if (typeof raw === "number" && Number.isFinite(raw))
    date = new Date(raw > 100000000000 ? raw : raw * 1000);
  else if (typeof raw === "string" && raw.trim()) {
    const value = raw.trim();
    const tenDigits = value.length === 10 && [...value].every(ch => ch >= "0" && ch <= "9");
    date = tenDigits ? new Date(Number(value) * 1000) : new Date(value);
  }
  if (!date || Number.isNaN(date.valueOf())) return null;
  const year = date.getUTCFullYear();
  if (year < 2000 || year > new Date().getUTCFullYear() + 1) return null;
  return date.toISOString().slice(0, 10);
}

export function getReportedReturns(performance) {
  const adjusted = performance?.loadAdjustedReturns;
  const overview = performance?.performanceOverview;
  const returns = {};
  const fields = {};
  const dates = {};
  // Prefer the fields that already match Yahoo's website for mutual funds.
  // Some ETFs omit loadAdjustedReturns but publish performanceOverview.
  for (const [source, obj, mapping] of [
    ["loadAdjustedReturns", adjusted, [
      ["YTD", "ytd"], ["1Y", "oneYear"], ["3Y", "threeYear"], ["5Y", "fiveYear"],
    ]],
    ["performanceOverview", overview, [
      ["YTD", "ytdReturnPct"], ["1Y", "oneYearTotalReturn"],
      ["3Y", "threeYearTotalReturn"], ["5Y", "fiveYrAvgReturnPct"],
    ]],
  ]) {
    if (!obj || typeof obj !== "object") continue;
    const date = parseAsOfDate(obj.asOfDate);
    for (const [term, field] of mapping) {
      if (term in returns) continue; // Never blend two sources for same period.
      const num = parseRatio(obj[field]);
      if (num === null) continue;
      returns[term] = num;
      fields[term] = "fundPerformance." + source + "." + field;
      dates[term] = date;
    }
  }
  return {
    returns, fields, dates,
    asof: parseAsOfDate(adjusted?.asOfDate ?? overview?.asOfDate),
  };
}

export function onlyUnrelatedRiskValidationErrors(error) {
  const errors = error?.errors;
  if (!Array.isArray(errors) || errors.length === 0) return false;
  return errors.every(issue => {
    const path = issue?.instancePath;
    return typeof path === "string" && (
      path.startsWith("/fundPerformance/riskOverviewStatistics/riskStatistics/") ||
      path.startsWith("/fundPerformance/riskOverviewStatisticsCat/riskStatisticsCat/")
    );
  });
}

export async function fetchFundPerformance(yahoo, symbol) {
  const query = { modules: ["fundPerformance"] };
  try {
    return await yahoo.quoteSummary(symbol, query);
  } catch (error) {
    // Yahoo omitted some risk statistics required by the library's schema.
    // That does not invalidate the unrelated return table.
    if (!onlyUnrelatedRiskValidationErrors(error)) throw error;
    console.log(symbol, "risk-statistics-only schema mismatch; validating returns independently");
    if (error?.result?.fundPerformance) return error.result;
    // Officially documented third-argument fallback when error.result is absent.
    return await yahoo.quoteSummary(symbol, query, { validateResult: false });
  }
}

export function importMetrics(fund, performance, retrieved) {
  if (fund.type === "money_market") return 0;
  const { returns, asof, fields, dates } = getReportedReturns(performance);
  const entries = Object.entries(returns);
  let changed = 0;
  if (entries.length) {
    fund.returns ??= {};
    fund.return_details ??= {};
    for (const [term, value] of entries) {
      fund.returns[term] = value;
      fund.return_details[term] = {
        source: "Yahoo Finance " + fields[term],
        method: "reported_yahoo_fund_performance",
        asof: dates[term],
        retrieved,
      };
      changed++;
    }
    fund.asof = asof || fund.asof;
    fund.source = "Yahoo Finance fund performance; see return_details per period";
  }
  // Annual performance is useful even when the trailing-return fields are absent.
  const annual = performance?.annualTotalReturns?.returns;
  if (Array.isArray(annual)) {
    const years = {};
    for (const item of annual) {
      const rawYear = item?.year && typeof item.year === "object" ? item.year.raw : item?.year;
      const year = Number(rawYear), number = parseRatio(item?.annualValue);
      if (Number.isInteger(year) && year >= 2000 && year <= 2100 && number !== null)
        years[String(year)] = number;
    }
    if (Object.keys(years).length) {
      fund.annual_total_returns = years;
      fund.annual_total_returns_source = "Yahoo Finance fundPerformance.annualTotalReturns";
      changed += Object.keys(years).length;
    }
  }
  return changed;
}

async function test() {
  function assert(condition, message) { if (!condition) throw new Error("Test failed: " + message); }
  const p = { loadAdjustedReturns: { ytd: 0.118, oneYear: 0.1209, threeYear: 0.2325, fiveYear: 0.1117, asOfDate: "2026-11-09" } };
  const x = getReportedReturns(p);
  assert(x.returns["1Y"] === 12.09, "1Y fractional return conversion");
  assert(x.returns["3Y"] === 23.25, "3Y fractional return conversion");
  assert(x.returns["5Y"] === 11.17, "5Y fractional return conversion");
  assert(x.returns.YTD === 11.8, "YTD fractional conversion");
  assert(x.asof === "2026-11-09", "As-of date");
  assert(parseRatio(3.0817) === null, "Reject impossible ratio (previous 308% error)");
  const f = {ticker:"FZROX",type:"index_mutual_fund",returns:{"1Y":13.12}};
  importMetrics(f,p,"2026-11-12");
  assert(f.returns["1Y"] === 12.09, "Prefer reported return over prior estimate");
  assert(f.return_details["1Y"].method === "reported_yahoo_fund_performance", "Record provenance");
  const m = {ticker:"FDLXX",type:"money_market",returns:{}};
  assert(importMetrics(m,p,"2026-11-12") === 0 && !m.returns["1Y"], "Don't use price-table returns for money markets");
  assert(parseRatio({ raw: 0.0615, fmt: "6.15%" }) === 6.15, "Unvalidated Yahoo numeric wrapper");
  const seconds = Date.parse("2026-11-09T00:00:00Z") / 1000;
  assert(parseAsOfDate({ raw: seconds }) === "2026-11-09", "Unix-seconds as-of date");
  const schemaError = {
    message: "Failed Yahoo Schema validation",
    errors: [{ instancePath: "/fundPerformance/riskOverviewStatistics/riskStatistics/2" }],
    result: { fundPerformance: p },
  };
  assert(onlyUnrelatedRiskValidationErrors(schemaError), "FZROX risk field schema mismatch");
  assert(onlyUnrelatedRiskValidationErrors({
    errors: [{ instancePath: "/fundPerformance/riskOverviewStatisticsCat/riskStatisticsCat/2" }]
  }), "IBDU category risk field schema mismatch");
  assert(!onlyUnrelatedRiskValidationErrors({
    errors: [{ instancePath: "/fundPerformance/loadAdjustedReturns/threeYear" }]
  }), "Reject unrelated return-field schema error");
  let calls = 0;
  const fake = { quoteSummary: async () => { calls++; throw schemaError; } };
  const recovered = await fetchFundPerformance(fake, "FZROX");
  assert(recovered?.fundPerformance === p && calls === 1, "Recover already fetched response");
  const ibdu = {
    performanceOverview: {
      ytdReturnPct: { raw: 0.011, fmt: "1.10%" },
      oneYearTotalReturn: { raw: 0.02, fmt: "2.00%" },
      threeYearTotalReturn: { raw: 0.068, fmt: "6.80%" },
      fiveYrAvgReturnPct: { raw: 0.012, fmt: "1.20%" },
      asOfDate: { raw: seconds },
    },
    performanceOverviewCat: { oneYearTotalReturn: 0.80 },
  };
  const ibduResult = getReportedReturns(ibdu);
  assert(ibduResult.returns["1Y"] === 2.00, "IBDU ETF fallback to performanceOverview 1Y");
  assert(ibduResult.returns["3Y"] === 6.80, "IBDU ETF fallback to performanceOverview 3Y");
  assert(ibduResult.returns["5Y"] === 1.20, "IBDU ETF fallback to performanceOverview 5Y");
  assert(ibduResult.returns.YTD === 1.10, "IBDU ETF fallback to performanceOverview YTD");
  assert(ibduResult.fields["1Y"] === "fundPerformance.performanceOverview.oneYearTotalReturn", "Track ETF field provenance");
  const etf = { ticker: "IBDU", type: "bond_etf", returns: { "3Y": 6.15 }};
  importMetrics(etf, ibdu, "2026-11-12");
  assert(etf.returns["3Y"] === 6.80 && etf.returns["1Y"] === 2, "ETF values imported");
  assert(etf.return_details["3Y"].source.includes("performanceOverview"), "ETF period source");
  const mixed = getReportedReturns({
    loadAdjustedReturns: { oneYear: 0.03 },
    performanceOverview: { oneYearTotalReturn: 0.04, threeYearTotalReturn: 0.05 },
  });
  assert(mixed.returns["1Y"] === 3 && mixed.returns["3Y"] === 5, "Prioritize adjusted; fill missing overview periods");
  const yearly = { ticker: "IBDU", type: "bond_etf" };
  importMetrics(yearly, { annualTotalReturns: { returns: [
    {year: 2024, annualValue: 0.035}, {year: 2025, annualValue: {raw: 0.049}},
  ]}}, "2026-11-12");
  assert(yearly.annual_total_returns["2024"] === 3.5, "Keep annual history without trailing returns");
  assert(yearly.annual_total_returns["2025"] === 4.9, "Decode unvalidated annual history");
  console.log("Yahoo fundPerformance validation, ETF fallback and annual-history tests passed.");
}

async function main() {
  if (process.argv.includes("--self-test")) { await test(); return; }
  const { default: YahooFinance } = await import("yahoo-finance2");
  const yahoo = new YahooFinance();
  const data = JSON.parse(fs.readFileSync(PATH, "utf8"));
  const retrieved = new Date().toISOString().slice(0,10);
  let updated = 0;
  for (const fund of data.funds ?? []) {
    if (!CORE.has(fund.ticker) || fund.type === "money_market") continue;
    try {
      const response = await fetchFundPerformance(yahoo, fund.ticker);
      const perf = response?.fundPerformance;
      const { returns, asof, fields } = getReportedReturns(perf);
      console.log(fund.ticker, perf ? "fundPerformance received" : "fundPerformance absent",
                  JSON.stringify(returns), "as-of", asof || "unknown",
                  "fields", JSON.stringify(fields));
      const annualCount = Array.isArray(perf?.annualTotalReturns?.returns)
        ? perf.annualTotalReturns.returns.length : 0;
      if (Object.keys(returns).length === 0 && annualCount === 0) {
        // Log just performance-module shapes, not the verbose and unrelated
        // risk statistics that caused Yahoo's schema validation problems.
        const overview = perf?.performanceOverview || {};
        const adjusted = perf?.loadAdjustedReturns || {};
        console.log(fund.ticker, "available performance field names:",
                    JSON.stringify({ performanceOverview: Object.keys(overview),
                                     loadAdjustedReturns: Object.keys(adjusted),
                                     annualReturnsRows: annualCount }));
        const wanted = ["ytdReturnPct", "oneYearTotalReturn",
                        "threeYearTotalReturn", "fiveYrAvgReturnPct"];
        const samples = {};
        for (const key of wanted) {
          const raw = overview[key];
          if (raw == null) continue;
          if (typeof raw === "number" && Number.isFinite(raw))
            samples[key] = raw;
          else if (typeof raw?.raw === "number" && Number.isFinite(raw.raw))
            samples[key] = { raw: raw.raw, fmt: typeof raw.fmt === "string" ? raw.fmt : undefined };
        }
        console.log(fund.ticker, "ETF return candidates (for unit verification):", JSON.stringify(samples));
        console.log(fund.ticker, "no usable fund-performance fields; prior figures retained");
        continue;
      }
      updated += importMetrics(fund, perf, retrieved);
    } catch (error) {
      console.log(fund.ticker, "fundPerformance unavailable; old figures retained:", String(error?.message || error).slice(0,180));
    }
    await new Promise(resolve => setTimeout(resolve, 1200));
  }
  if (updated > 0) {
    data.yahoo_performance_checked = retrieved;
    fs.writeFileSync(PATH, JSON.stringify(data, null, 2) + "\n");
  }
  console.log("Direct Yahoo fund-performance fields updated:", updated);
}
main().catch(err => {console.error("Unexpected error in direct fund performance query:", err.message); process.exitCode = 1});
