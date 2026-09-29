// fusion-tools: severity x busy routing (A9) plus the exact ack strings.
//
// routeNote is pure against a transport of {prompt, synthetic, queue} so
// node:test can drive every cell of the table with mocked calls.

export const ACK_DELIVERED = "Delivered.";
export const ACK_QUEUED = "Queued for the next review.";
export const ACK_RAISED = "Dropped: already raised.";
export const ACK_NOISE = "Dropped: noise.";
export const ACK_BUDGET = "Dropped: this update's advice budget is spent.";
export const ACK_NO_SESSION = "Dropped: no watched session.";

// Routing table (A9):
//   busy + blocker -> prompt steer
//   busy + concern -> defer
//   busy + nit     -> defer
//   idle + blocker -> prompt steer (starts a run)
//   idle + concern -> synthetic (resume:false)
//   idle + nit     -> synthetic (resume:false)
export function decideRoute(severity, busy) {
  if (severity === "blocker") return "prompt";
  return busy ? "defer" : "synthetic";
}

// transport: {
//   prompt: (primarySessionID, note) => Promise<void>,   // steer injection
//   synthetic: (primarySessionID, note) => Promise<void>,// silent aside
//   defer: (primarySessionID, note, severity) => void,   // parked locally
// }
// Returns one of the ACK_* strings.
export async function routeNote({ severity, busy, note, primarySessionID, transport }) {
  const action = decideRoute(severity, busy);
  try {
    if (action === "prompt") {
      await transport.prompt(primarySessionID, note);
      return ACK_DELIVERED;
    }
    if (action === "synthetic") {
      await transport.synthetic(primarySessionID, note);
      return ACK_DELIVERED;
    }
    transport.defer(primarySessionID, note, severity);
    return ACK_QUEUED;
  } catch (cause) {
    // routing errors surface as tool errors so the advisor can see them
    throw new Error("routing failed: " + String(cause && cause.message ? cause.message : cause));
  }
}
