export function areaM2(value: { area_m2?: unknown; area?: unknown } | null | undefined): number | null {
  if (!value) return null;
  if (Object.hasOwn(value, "area_m2") && (typeof value.area_m2 === "number" || value.area_m2 === null)) {
    return Number.isFinite(value.area_m2 as number) ? value.area_m2 as number : null;
  }
  if (typeof value.area === "number" && Number.isFinite(value.area)) return value.area;
  return null;
}

export function numericAreaM2(value: { area_m2?: unknown; area?: unknown } | null | undefined): number {
  const result = areaM2(value);
  return result === null ? 0 : result;
}

export function formatAreaM2(value: { area_m2?: unknown; area?: unknown } | null | undefined): string {
  const result = areaM2(value);
  return result === null ? "—" : `${result.toLocaleString("pt-BR", { maximumFractionDigits: 3 })} m²`;
}
