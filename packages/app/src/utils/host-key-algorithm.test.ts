import { describe, expect, it } from "vitest";
import { describeHostKeyAlgorithm } from "./host-key-algorithm";

describe("describeHostKeyAlgorithm", () => {
  it("maps each OpenSSH host key type to its label and host key file", () => {
    expect(describeHostKeyAlgorithm("ssh-ed25519")).toEqual({
      label: "ED25519",
      hostKeyFile: "/etc/ssh/ssh_host_ed25519_key.pub",
    });
    expect(describeHostKeyAlgorithm("rsa-sha2-512")).toEqual({
      label: "RSA",
      hostKeyFile: "/etc/ssh/ssh_host_rsa_key.pub",
    });
    expect(describeHostKeyAlgorithm("ssh-rsa").label).toBe("RSA");
    expect(describeHostKeyAlgorithm("ecdsa-sha2-nistp256")).toEqual({
      label: "ECDSA P-256",
      hostKeyFile: "/etc/ssh/ssh_host_ecdsa_key.pub",
    });
    expect(describeHostKeyAlgorithm("ecdsa-sha2-nistp521").label).toBe("ECDSA P-521");
    expect(describeHostKeyAlgorithm("ssh-dss").hostKeyFile).toBe("/etc/ssh/ssh_host_dsa_key.pub");
  });

  it("reads host certificates as their key type", () => {
    expect(describeHostKeyAlgorithm("ssh-ed25519-cert-v01\u0040openssh.com").label).toBe("ED25519");
    expect(describeHostKeyAlgorithm("rsa-sha2-256-cert-v01\u0040openssh.com").label).toBe("RSA");
  });

  it("names no file for an unknown or missing algorithm", () => {
    expect(describeHostKeyAlgorithm("unknown")).toEqual({ label: "Host key", hostKeyFile: null });
    expect(describeHostKeyAlgorithm(undefined)).toEqual({ label: "Host key", hostKeyFile: null });
    expect(describeHostKeyAlgorithm("x-new-alg")).toEqual({
      label: "x-new-alg",
      hostKeyFile: null,
    });
  });
});
