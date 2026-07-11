const COST_TICK_DIVISOR = 10_000_000_000;

function numericField(value) {
  const parsed = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

export function usageDiagnostics(data) {
  const usage = isPlainObject(data?.usage) ? data.usage : {};
  const costTicks = numericField(usage.cost_in_usd_ticks);
  const explicitCostUsd = numericField(usage.cost_usd);
  const costUsd = costTicks == null ? explicitCostUsd : costTicks / COST_TICK_DIVISOR;

  return {
    ...(Object.keys(usage).length ? { usage } : {}),
    ...(costTicks == null ? {} : { cost_in_usd_ticks: costTicks }),
    ...(costUsd == null ? {} : { cost_usd: costUsd }),
  };
}
