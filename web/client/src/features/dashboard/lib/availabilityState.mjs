// Calendar metadata may survive selection validation, but validation itself
// belongs to one request. Identity tokens also reject A -> B -> A stale results.
export function settleAvailability(previous, request, signal, result) {
  if (signal.aborted) return previous;
  const { first, last, days, month } = result.data ?? {};
  return {
    request,
    ...result,
    calendar: result.data
      ? { scope: request.scope, data: { first, last, days, month } }
      : previous?.calendar,
  };
}

export function availabilityView(result, request, enabled) {
  const current = enabled && result?.request === request ? result : null;
  return {
    data: current?.data,
    error: current?.error,
    loading: !!enabled && !current,
    // Deliberately excludes validDates: retained data must never enable Apply.
    calendar: enabled && result?.calendar?.scope === request.scope
      ? result.calendar.data : undefined,
  };
}
