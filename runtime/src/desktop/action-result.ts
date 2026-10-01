import { ActionDeliveryMode, ActionEffect, ActionRoute, type ActionResult } from "@trycua/cua-driver";

/** Receipt validation happens after dispatch and cannot roll back input. */
export function desktopActionResult(action: ActionResult, fallbackSummary?: string) {
  if (action.delivery?.mode === ActionDeliveryMode.Foreground) {
    throw new Error("Desktop driver reported foreground delivery; side effects may have occurred");
  }
  if (action.route === ActionRoute.GlobalInput) {
    throw new Error("Desktop driver reported global input; side effects may have occurred");
  }
  let effect: "confirmed" | "partial" | "unverifiable" | "suspected-noop" | "refused";
  switch (action.effect) {
    case ActionEffect.Confirmed: effect = "confirmed"; break;
    case ActionEffect.Partial: effect = "partial"; break;
    case ActionEffect.Unverifiable: effect = "unverifiable"; break;
    case ActionEffect.SuspectedNoop: effect = "suspected-noop"; break;
    case ActionEffect.Refused: effect = "refused"; break;
    default: throw new Error("Desktop driver returned an unknown action effect");
  }
  return { effect, summary: action.summary ?? fallbackSummary };
}
