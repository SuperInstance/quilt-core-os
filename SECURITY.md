# Security policy

> **The Quilt appliance is designed to be un-brickable.** This document
> describes how the security model makes that guarantee, and how to
> report a vulnerability you have found.

---

## Our threat model

A Quilt edge device is expected to run unattended for years, in
locations where physical access cannot be fully controlled. We assume:

- The host network is hostile. Anything coming in over Ethernet,
  Wi-Fi, BLE, or serial is treated as untrusted.
- An attacker with physical access to the device can power-cycle it
  and plug in peripherals (USB, SD card), but cannot easily extract
  secrets from the SoC.
- The Quilt cell may contain untrusted user-supplied models or
  tool definitions that could attempt privilege escalation.
- The cloud control plane (`quilt-fleet`) is a trusted environment
  operated by SuperInstance, but the device's credentials to it
  are scoped to "this node" only.

We do **not** assume:

- The kernel or bootloader is intact after a tampering event. Both
  are re-verified on every boot via signed assertions.
- The Quilt cell process is bug-free. It runs under strict
  AppArmor + seccomp confinement.

---

## Why Quilt is un-brickable

The OS layer is [Ubuntu Core](https://ubuntu.com/core), which provides:

| Mechanism                      | What it does                                                         |
|--------------------------------|----------------------------------------------------------------------|
| Read-only root filesystem      | `/` cannot be modified at runtime; only updated by a transactional snap refresh. |
| A/B partitions                 | Two parallel system partitions; the bootloader can boot either.      |
| Signed kernel + bootloader      | The bootloader refuses to boot a kernel whose signature is invalid.  |
| snapd with auto-rollback        | After a refresh, the new boot must pass a health check, else snapd reverts to the previous slot. |
| Encrypted state partition      | `writable` is LUKS-encrypted with a device-bound key; tampering is detectable. |
| TPM-measured boot              | PCRs are extended with every loaded component; a measured-boot verifier can attest the running system. |

If a refresh fails, the bootloader simply does not switch slots.
If the new boot fails its health check, snapd reverts the slot.
If the device loses power mid-refresh, the next boot picks up the
un-flipped slot. **There is no path that ends with a non-booting
device.**

---

## Cryptographic signing

All artifacts in the Quilt update chain are signed:

| Artifact                       | Signed by                            | Verified by              |
|--------------------------------|--------------------------------------|--------------------------|
| Ubuntu Core image              | `canonical` (publisher in the model) | the bootloader           |
| Kernel + bootloader            | `canonical`                          | the bootloader           |
| `quilt-core` snap              | `superinstance`                      | snapd                    |
| Snap assertions                | `superinstance` (model key)          | snapd                    |
| OTA channel assignment         | `superinstance`                      | snapd                    |
| quilt-fleet RPC payload        | TLS + node-level HMAC                | the receiving service   |

We do **not** publish unsigned images. We do **not** accept a snap
uploaded by anyone outside the `@superinstance/snap-publishers`
team. The store enforces both.

### Model key rotation

The Ubuntu Core model key can be rotated. When it is, all existing
images stop receiving automatic updates until they re-enroll with
the new model. Re-enrollment is operator-initiated and requires
physical access to the device.

If you are a customer running a private model, you control the
signing key yourself. SuperInstance does not have it.

---

## Reporting a vulnerability

**Please do not open a public GitHub issue for security bugs.**

Email **security@superinstance.io** with:

- A clear description of the issue.
- A reproducer (PoC, screen recording, or step-by-step).
- The impact you believe it has.
- Whether you would like public credit.

We aim to acknowledge within **2 business days** and provide a
triage decision within **7 days**. Critical issues are fixed out
of band and disclosed via a security advisory; we coordinate
disclosure timing with you.

You can also report via:

- GitHub Security Advisories: <https://github.com/SuperInstance/quilt-core-os/security/advisories/new>
- OpenSSF Slack `#quilt` channel (DM a maintainer).

---

## Supported versions

We provide security fixes for the current stable and beta
channels. The `edge` channel is best-effort and may be
force-pushed.

| Channel | Supported? | Notes                                |
|---------|-----------|--------------------------------------|
| stable  | ✅ yes    | tagged releases; LTS-style backports |
| beta    | ✅ yes    | weekly; fixes land here first        |
| edge    | ⚠️ best-effort | daily CI; may be force-pushed   |

A device pinned to a specific revision (via `quilt-fleet`) will
continue to receive that revision's backports regardless of
channel changes.

---

## Hardening checklist for operators

If you operate a fleet of Quilt devices, do these things:

1. **Pin revisions in production.** Don't run `stable`; run
   pinned `stable/X.Y.Z`. This is the single most important
   thing.
2. **Enable Secure Boot on every device.** Pi 4/5 and Jetson
   support it. core24 turns it on by default but you can verify
   with `mokutil --sb-state` (x86) or `dmesg | grep -i secure`
   (arm).
3. **Rotate the fleet enrollment token.** Default lifetime is 90
   days. Set a cron or use `quilt-fleet` to rotate.
4. **Ship your own brand store.** Don't rely on the public snap
   store for production; brand-store your own revisions and
   install via `--classic` from your own URL.
5. **Enable the audit log.** snapd logs every refresh attempt to
   `/var/log/journal`. Ship that to your SIEM.
6. **Run `quilt-core doctor` periodically.** It's a one-shot
   probe; wire it into your monitoring.
7. **Physically lock the SD card slot.** The `writable`
   partition is encrypted, but a determined attacker with
   unlimited physical access can still re-flash. Don't make
   that easy.
8. **TPM-measured boot.** On x86, enable the attestation agent.
   This is the only way to detect a bootloader-level compromise.

---

## Acknowledgements

We thank the following researchers for responsible disclosures:

- _No entries yet — be the first!_

---

_Last updated: 2024-09-01_
