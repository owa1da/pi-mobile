// Host key algorithm → a short label and the OpenSSH host key file that holds it, so the trust
// sheet's "check it on the host" hint names the file that actually matches the presented key.

export interface HostKeyAlgorithmInfo {
  /** Short label for the fingerprint card: ED25519, RSA, ECDSA P-256, … */
  label: string;
  /** `ssh_host_<type>_key.pub` under /etc/ssh, or null when the algorithm is unknown. */
  hostKeyFile: string | null;
}

const ECDSA_CURVES: Record<string, string> = {
  nistp256: "P-256",
  nistp384: "P-384",
  nistp521: "P-521",
};

function stripCertSuffix(algorithm: string): string {
  return algorithm.replace(/-cert-v0\d+\u0040openssh\.com$/, "");
}

export function describeHostKeyAlgorithm(
  algorithm: string | null | undefined,
): HostKeyAlgorithmInfo {
  const raw = stripCertSuffix((algorithm ?? "").trim().toLowerCase());
  if (raw === "ssh-ed25519" || raw === "sk-ssh-ed25519\u0040openssh.com")
    return { label: "ED25519", hostKeyFile: "/etc/ssh/ssh_host_ed25519_key.pub" };
  if (raw === "ssh-rsa" || raw.startsWith("rsa-sha2-"))
    return { label: "RSA", hostKeyFile: "/etc/ssh/ssh_host_rsa_key.pub" };
  const ecdsa = /^(?:sk-)?ecdsa-sha2-(nistp\d+)/.exec(raw);
  if (ecdsa) {
    const curve = ECDSA_CURVES[ecdsa[1]!];
    return {
      label: curve ? `ECDSA ${curve}` : "ECDSA",
      hostKeyFile: "/etc/ssh/ssh_host_ecdsa_key.pub",
    };
  }
  if (raw === "ssh-dss") return { label: "DSA", hostKeyFile: "/etc/ssh/ssh_host_dsa_key.pub" };
  if (!raw || raw === "unknown") return { label: "Host key", hostKeyFile: null };
  return { label: raw, hostKeyFile: null };
}
