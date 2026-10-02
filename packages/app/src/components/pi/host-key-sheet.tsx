// Host key sheets: first-use trust (TOFU) and a changed pinned key. Fingerprints in the mono face.

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { splitFingerprint } from "@/stores/tofu";
import { describeHostKeyAlgorithm } from "@/utils/host-key-algorithm";
import { SheetActions, sheetActionStyles } from "./sheet-actions";

const TRUST_SNAP_POINTS = ["55%"];
const MISMATCH_SNAP_POINTS = ["70%", "90%"];

function Fingerprint({
  label,
  fingerprint,
  testID,
}: {
  label: string;
  fingerprint: string;
  testID?: string;
}) {
  const { prefix, digest } = splitFingerprint(fingerprint);
  return (
    <View style={styles.fingerprint} testID={testID}>
      <Text style={styles.fingerprintLabel}>{prefix ? `${label} · ${prefix}` : label}</Text>
      <Text style={styles.fingerprintDigest} selectable>
        {digest}
      </Text>
    </View>
  );
}

/** A command to run on the host: prose lead-in, then the command in its own selectable mono block. */
function HostCommand({ lead, command }: { lead: string; command: string }) {
  return (
    <View style={styles.commandGroup}>
      <Text style={styles.hint}>{lead}</Text>
      <View style={styles.fingerprint} testID="host-key-hint">
        <Text style={styles.command} selectable>
          {command}
        </Text>
      </View>
    </View>
  );
}

const ANY_HOST_KEY_COMMAND = "for f in /etc/ssh/ssh_host_*_key.pub; do ssh-keygen -lf $f; done";

interface TrustSheetProps {
  visible: boolean;
  hostLabel: string;
  /** The presented key's algorithm, e.g. "ssh-ed25519" or "rsa-sha2-512". */
  algorithm: string;
  fingerprint: string;
  onTrust: () => void;
  onCancel: () => void;
}

export function HostKeyTrustSheet({
  visible,
  hostLabel,
  algorithm,
  fingerprint,
  onTrust,
  onCancel,
}: TrustSheetProps) {
  const { t } = useTranslation();
  const keyInfo = describeHostKeyAlgorithm(algorithm);
  const command = keyInfo.hostKeyFile
    ? `ssh-keygen -lf ${keyInfo.hostKeyFile}`
    : ANY_HOST_KEY_COMMAND;
  const header = useMemo(() => ({ title: t("pi.hostKey.trustTitle") }), [t]);
  const footer = useMemo(
    () => (
      <SheetActions>
        <Button
          variant="ghost"
          onPress={onCancel}
          style={sheetActionStyles.button}
          testID="host-key-cancel"
        >
          {t("pi.hostKey.cancel")}
        </Button>
        <Button
          variant="default"
          onPress={onTrust}
          style={sheetActionStyles.button}
          testID="host-key-trust"
        >
          {t("pi.hostKey.trust")}
        </Button>
      </SheetActions>
    ),
    [onCancel, onTrust, t],
  );
  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onCancel}
      footer={footer}
      snapPoints={TRUST_SNAP_POINTS}
      testID="host-key-sheet"
    >
      <View style={styles.body}>
        <Text style={styles.text}>{t("pi.hostKey.trustBody", { label: hostLabel })}</Text>
        <Fingerprint
          label={keyInfo.label}
          fingerprint={fingerprint}
          testID="host-key-fingerprint"
        />
        <HostCommand lead={t("pi.hostKey.checkLead")} command={command} />
      </View>
    </AdaptiveModalSheet>
  );
}

interface MismatchSheetProps {
  visible: boolean;
  hostLabel: string;
  pinned: string;
  presented: string;
  replacing: boolean;
  onReplace: () => void;
  onCancel: () => void;
}

export function HostKeyMismatchSheet({
  visible,
  hostLabel,
  pinned,
  presented,
  replacing,
  onReplace,
  onCancel,
}: MismatchSheetProps) {
  const { t } = useTranslation();
  const header = useMemo(() => ({ title: t("pi.hostKey.mismatchTitle") }), [t]);
  const footer = useMemo(
    () => (
      <SheetActions>
        <Button
          variant="ghost"
          onPress={onCancel}
          style={sheetActionStyles.button}
          testID="host-key-mismatch-cancel"
        >
          {t("pi.hostKey.cancel")}
        </Button>
        <Button
          variant="destructive"
          onPress={onReplace}
          loading={replacing}
          style={sheetActionStyles.button}
          testID="host-key-replace"
        >
          {t("pi.hostKey.replace")}
        </Button>
      </SheetActions>
    ),
    [onCancel, onReplace, replacing, t],
  );
  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onCancel}
      footer={footer}
      snapPoints={MISMATCH_SNAP_POINTS}
      testID="host-key-mismatch-sheet"
    >
      <View style={styles.body}>
        <Text style={styles.text}>{t("pi.hostKey.mismatchBody", { label: hostLabel })}</Text>
        <Fingerprint label={t("pi.hostKey.pinned")} fingerprint={pinned} />
        <Fingerprint
          label={t("pi.hostKey.presented")}
          fingerprint={presented}
          testID="host-key-presented"
        />
        <HostCommand lead={t("pi.hostKey.mismatchCheckLead")} command={ANY_HOST_KEY_COMMAND} />
        <Text style={styles.hint}>{t("pi.hostKey.replaceHint")}</Text>
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { gap: theme.spacing[4], paddingBottom: theme.spacing[4] },
  text: { color: theme.colors.foreground, fontSize: theme.fontSize.base, lineHeight: 21 },
  hint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: 17,
  },
  commandGroup: { gap: theme.spacing[2] },
  command: {
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
    lineHeight: 18,
  },
  fingerprint: {
    gap: theme.spacing[1],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface2,
  },
  fingerprintLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  fingerprintDigest: {
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.base,
    lineHeight: 20,
  },
}));
