import type { ScreenObservation } from "../../../extensions/screen-observation/types.js";
import { boundedText } from "../shared/request-budget.js";
import type { ChronicleObservationProjection } from "./types.js";

const TITLE_MAX_CHARACTERS = 200;
const FOCUSED_VALUE_MAX_CHARACTERS = 2_000;
const VISIBLE_TEXT_MAX_CHARACTERS = 4_000;

function limited(value: string | undefined, maxCharacters: number) {
  if (value === undefined || value === "") return undefined;
  return boundedText(value, maxCharacters).text;
}

function definedEntries<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}

export function projectChronicleObservation(
  observation: ScreenObservation,
): ChronicleObservationProjection {
  const focusedElement = observation.focusedElement
    ? definedEntries({
        role: boundedText(observation.focusedElement.role, 100).text,
        subrole: limited(observation.focusedElement.subrole, 100),
        title: limited(observation.focusedElement.title, TITLE_MAX_CHARACTERS),
        value: limited(
          observation.focusedElement.value,
          FOCUSED_VALUE_MAX_CHARACTERS,
        ),
        identifier: limited(observation.focusedElement.identifier, 200),
        description: limited(observation.focusedElement.description, 1_000),
        focused: observation.focusedElement.focused,
        enabled: observation.focusedElement.enabled,
        selected: observation.focusedElement.selected,
      })
    : undefined;
  return definedEntries({
    type: "screen_observation" as const,
    sourceId: `observation:${observation.id}`,
    occurredAt: observation.occurredAt,
    capturedAt: observation.capturedAt,
    application: definedEntries({
      name: boundedText(observation.window.applicationName, 200).text,
      bundleIdentifier: limited(observation.window.bundleIdentifier, 300),
    }),
    windowTitle: limited(observation.window.title, TITLE_MAX_CHARACTERS),
    url: limited(observation.url, 2_048),
    focusedElement,
    visibleText: boundedText(
      observation.visibleText,
      VISIBLE_TEXT_MAX_CHARACTERS,
    ).text,
  });
}
