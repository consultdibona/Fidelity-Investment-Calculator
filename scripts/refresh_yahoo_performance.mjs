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
  // quoteSummary fundPerformance percentage fields are fraction-of-one rates.
  // Treat numbers outside [-1,1] as unsupported, rather than guessing units.
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= -1 || raw >= 1) return null;
  const percent = +(raw * 100).toFixed(2);
  return percent > -100 && percent < 100 ? percent : null;
}

export function getReportedReturns(performance) {
  const a = performance?.loadAdjustedReturns;
  if (!a || typeof a !== "object") return { returns: {}, asof: null };
  const returns = {};
  for (const [key, field] of [
    ["YTD", "ytd"], ["1Y", "oneYear"],
    ["3Y", "threeYear"], ["5Y", "fiveYear"],
  ]) {
    const number = parseRatio(a[field]);
    if (number !== null) returns[key] = number;
  }
  let asof = null;
  const rawDate = a.asOfDate ?? performance?.performanceOverview?.asOfDate;
  if (rawDate != null) {
    const date = new Date(rawDate);
    if (!Number.isNaN(date.valueOf())) asof = date.toISOString().slice(0, 10);
  }
  return { returns, asof };
}

export function importMetrics(fund, performance, retrieved) {
  if (fund.type === "money_market") return 0;
  const { returns, asof } = getReportedReturns(performance);
  const entries = Object.entries(returns);
  if (!entries.length) return 0;
  fund.returns ??= {};
  fund.return_details ??= {};
  for (const [term, value] of entries) {
    fund.returns[term] = value;
    fund.return_details[term] = {
      source: "Yahoo Finance fundPerformance.loadAdjustedReturns",
      method: "reported_yahoo_fund_performance",
      asof,
      retrieved,
    };
  }
  fund.asof = asof || fund.asof;
  fund.source = "Yahoo Finance fund performance; see return_details per period";
  const annual = performance?.annualTotalReturns?.returns;
  if (Array.isArray(annual)) {
    const years = {};
    for (const item of annual) {
      const year = Number(item?.year), number = parseRatio(item?.annualValue);
      if (Number.isInteger(year) && year >= 2000 && year <= 2100 && number !== null)
        years[String(year)] = number;
    }
    if (Object.keys(years).length) {
      fund.annual_total_returns = years;
      fund.annual_total_returns_source = "Yahoo Finance fundPerformance.annualTotalReturns";
    }
  }
  return entries.length;
}

function test() {
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
  console.log("Yahoo fundPerformance mapping tests passed.");
}

async function main() {
  if (process.argv.includes("--self-test")) { test(); return; }
  const { default: YahooFinance } = await import("yahoo-finance2");
  const yahoo = new YahooFinance();
  const data = JSON.parse(fs.readFileSync(PATH, "utf8"));
  const retrieved = new Date().toISOString().slice(0,10);
  let updated = 0;
  for (const fund of data.funds ?? []) {
    if (!CORE.has(fund.ticker) || fund.type === "money_market") continue;
    try {
      const response = await yahoo.quoteSummary(fund.ticker, { modules: ["fundPerformance"] });
      const perf = response?.fundPerformance;
      const { returns, asof } = getReportedReturns(perf);
      console.log(fund.ticker, perf ? "fundPerformance received" : "fundPerformance absent", JSON.stringify(returns), "as-of", asof || "unknown");
      if (Object.keys(returns).length === 0) {
        console.log(fund.ticker, "module has no usable percentage fields; old figures retained");
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
