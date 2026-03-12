export type StatusVerificationState =
  | "verified"
  | "country_mismatch"
  | "country_unconfirmed"
  | "unavailable";

export type StatusParseResult = {
  connected?: boolean;
  ipInfo?: Record<string, unknown>;
  observedCountry?: string;
  verificationState?: StatusVerificationState;
  verificationMessage?: string;
};

export function parseStatusOutput(stdout: string): StatusParseResult | undefined {
  if (!stdout) return undefined;

  const normalized = stdout.toLowerCase();
  const connected =
    normalized.includes("vpn process: running") || normalized.includes("vpn: connected")
      ? true
      : normalized.includes("vpn: disconnected")
        ? false
        : undefined;

  let verificationState: StatusVerificationState | undefined;
  let verificationMessage: string | undefined;

  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lowered = line.toLowerCase();

    if (lowered.includes("tunnel verified")) {
      verificationState = "verified";
      const nextLine = lines[index + 1];
      if (nextLine && !nextLine.startsWith("🔒") && !nextLine.startsWith("🔓") && !nextLine.startsWith("🌍")) {
        verificationMessage = nextLine;
      }
      break;
    }
    if (lowered.includes("country mismatch")) {
      verificationState = "country_mismatch";
      verificationMessage = line;
      break;
    }
    if (lowered.includes("country unconfirmed")) {
      verificationState = "country_unconfirmed";
      verificationMessage = line;
      break;
    }
    if (lowered.includes("country check unavailable")) {
      verificationState = "unavailable";
      verificationMessage = line;
      break;
    }
  }

  let observedCountry: string | undefined;
  const countryMatch = stdout.match(/\|\s*([A-Za-z]{2})\s*\|/);
  if (countryMatch) {
    observedCountry = countryMatch[1].toUpperCase();
  }

  const firstBrace = stdout.indexOf("{");
  let ipInfo: Record<string, unknown> | undefined;

  if (firstBrace >= 0) {
    try {
      const parsed = JSON.parse(stdout.slice(firstBrace));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        ipInfo = parsed as Record<string, unknown>;
      }
    } catch {
      ipInfo = undefined;
    }
  }

  return { connected, ipInfo, observedCountry, verificationState, verificationMessage };
}

export function statusCountryCode(parsed: Record<string, unknown> | undefined): string | undefined {
  const observedCountry = parsed?.observedCountry;
  if (typeof observedCountry === "string" && observedCountry.trim() !== "") {
    return observedCountry.toUpperCase();
  }

  const ipInfo = parsed?.ipInfo;
  if (!ipInfo || typeof ipInfo !== "object" || Array.isArray(ipInfo)) {
    return undefined;
  }

  const country = (ipInfo as Record<string, unknown>).country;
  return typeof country === "string" && country.trim() !== "" ? country.toUpperCase() : undefined;
}
