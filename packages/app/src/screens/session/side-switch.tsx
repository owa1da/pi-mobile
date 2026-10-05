import { PanelRight } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import type { SessionRow } from "@/host/types";
import { useSideSwitch } from "@/screens/forge/use-side-navigation";
import { MIN_TOUCH } from "@/styles/touch";
import type { RemoteChannel } from "./use-remote-channel";

/** A quiet header destination, not /side's create/replace command. */
export function SideSwitch({
  hostId,
  row,
  channel,
}: {
  hostId: string;
  row: SessionRow;
  channel: RemoteChannel;
}) {
  const { t } = useTranslation();
  const { switchSide, busy } = useSideSwitch(hostId, row, channel);
  if (!channel.available || !channel.state?.side?.id) return null;
  return (
    <Button
      variant="ghost"
      size="md"
      leftIcon={PanelRight}
      style={styles.button}
      disabled={busy}
      onPress={switchSide}
      accessibilityRole="button"
      accessibilityLabel={t("pi.session.openSide")}
      testID="session-side-switch"
    />
  );
}

const styles = StyleSheet.create(() => ({
  button: { minWidth: MIN_TOUCH, minHeight: MIN_TOUCH },
}));
