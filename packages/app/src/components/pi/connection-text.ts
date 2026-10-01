// Human text for a connection failure.

import type { TFunction } from "i18next";
import { failureMessageKey, type ConnectionFailure } from "@/stores/connection-errors";

export function failureText(t: TFunction, failure: ConnectionFailure | undefined): string {
  if (!failure) return "";
  return t(failureMessageKey(failure.kind), { message: failure.message ?? "" });
}
