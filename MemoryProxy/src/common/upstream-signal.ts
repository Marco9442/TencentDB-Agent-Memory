export function composeUpstreamSignal(
  requestSignal: AbortSignal,
  timeoutMs: number,
): AbortSignal {
  return timeoutMs > 0
    ? AbortSignal.any([requestSignal, AbortSignal.timeout(timeoutMs)])
    : requestSignal;
}
