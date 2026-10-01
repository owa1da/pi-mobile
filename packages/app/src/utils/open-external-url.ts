import * as Linking from "expo-linking";
import { isWeb } from "@/constants/platform";

import { isHttpUrl } from "./http-url";

export async function openExternalUrl(url: string): Promise<void> {
  if (!isHttpUrl(url)) return;
  if (isWeb) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }

  await Linking.openURL(url);
}
