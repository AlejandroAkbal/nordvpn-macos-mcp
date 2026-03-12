import test from "node:test";
import assert from "node:assert/strict";
import { parseStatusOutput, statusCountryCode } from "../dist/status-parser.js";

test("parseStatusOutput detects verified state and extracts message", () => {
  const stdout = [
    "🔒 VPN process: running",
    "✅  Tunnel verified — 45.80.184.37 | SG | Kampong Loyang | AS212238 Datacamp Limited",
    "country TH confirmed by majority vote (2/3 providers: ipapi.is, ipwho.is)",
  ].join("\n");

  const parsed = parseStatusOutput(stdout);
  assert.ok(parsed);
  assert.equal(parsed.connected, true);
  assert.equal(parsed.verificationState, "verified");
  assert.equal(parsed.verificationMessage, "country TH confirmed by majority vote (2/3 providers: ipapi.is, ipwho.is)");
  assert.equal(parsed.observedCountry, "SG");
  assert.equal(statusCountryCode(parsed), "SG");
});

test("parseStatusOutput detects country mismatch state", () => {
  const stdout = [
    "🔒 VPN process: running",
    "⚠️  Country mismatch — requested TH, majority vote says SG via ipinfo, ipwho.is",
  ].join("\n");

  const parsed = parseStatusOutput(stdout);
  assert.ok(parsed);
  assert.equal(parsed.connected, true);
  assert.equal(parsed.verificationState, "country_mismatch");
  assert.match(String(parsed.verificationMessage), /country mismatch/i);
});

test("parseStatusOutput detects country unconfirmed state", () => {
  const stdout = [
    "🔒 VPN process: running",
    "⚠️  Country unconfirmed — provider results disagree: TH via ipapi.is, SG via ipinfo",
  ].join("\n");

  const parsed = parseStatusOutput(stdout);
  assert.ok(parsed);
  assert.equal(parsed.connected, true);
  assert.equal(parsed.verificationState, "country_unconfirmed");
  assert.match(String(parsed.verificationMessage), /country unconfirmed/i);
});

test("statusCountryCode falls back to ipInfo country", () => {
  const parsed = parseStatusOutput('{"ip":"1.2.3.4","country":"TH"}');
  assert.ok(parsed);
  assert.equal(statusCountryCode(parsed), "TH");
});
