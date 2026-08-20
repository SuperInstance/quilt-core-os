# Recovery — when things go wrong

> **TL;DR.** Try `quilt-core doctor` first. If that fails, reboot.
> If that fails, snapd will auto-revert. If snapd cannot revert,
> boot the previous kernel from the bootloader menu. If the SD
> card is dead, re-flash. **There is no brick mode.**

This document is a structured walkthrough of failure modes and
their remedies, in order from most to least common.

---

## 0. The four levels of failure

Quilt's recovery story is layered. The deeper you go, the more
you are reaching for a hand-driven process; the shallower you
stay, the more the OS recovers for you.

| Level | Failure mode                              | Who fixes it         |
|-------|-------------------------------------------|----------------------|
| L1    | A single Quilt cell crashes               | the daemon           |
| L2    | The daemon itself crashes                 | snapd                |
| L3    | The new snap revision is bad              | snapd auto-rollback  |
| L4    | The kernel/base is bad / SD card corrupted | you, with a re-flash |

L1–L3 are *automated*. You should not normally see them. L4
requires a person with a card reader and 20 minutes.

---

## 1. A single cell crashes (`quilt-core cell list` shows `failed`)

**Symptom:** One cell is in `failed` state, the rest are fine.

**Cause:** The cell's command exited non-zero. Common reasons:
bad model file, OOM, a crash in a downstream library.

**Fix:**

```bash
# 1. Look at the cell's logs.
quilt-core cell logs <id> --tail=200

# 2. Restart it.
quilt-core cell restart <id>

# 3. If it keeps failing, look at the exit code and stdout/stderr.
#    The logs include the exit code.
quilt-core cell get <id> | grep exitCode
```

If the cell keeps failing, check the host's resources:

```bash
free -h
df -h /var/snap/quilt-core
journalctl -u snap.quilt-core.daemon.service --since "10 min ago"
```

The daemon continues to serve all other cells; the failure is
isolated to the cell.

---

## 2. The daemon itself crashes

**Symptom:** `quilt-core status` errors with "socket not found"
or "connection refused". `journalctl -u snap.quilt-core.daemon.service`
shows the daemon exiting.

**Cause:** A bug in the daemon, an OOM kill, or an
unhandled-promise rejection.

**Fix:** snapd restarts the daemon automatically
(`restart-condition: on-failure`, `restart-delay: 5s`). Wait 30
seconds; if it does not come back, look at the journal:

```bash
sudo journalctl -u snap.quilt-core.daemon.service -n 200 --no-pager
```

If the daemon is in a crash loop, you can stop the snap service
and start the daemon manually for diagnosis:

```bash
sudo systemctl stop snap.quilt-core.daemon.service
sudo /snap/quilt-core/current/bin/quilt-core daemon
```

(The snap installs the daemon binary at
`/snap/quilt-core/current/bin/quilt-core` and
`/snap/quilt-core/current/opt/quilt-core/dist/daemon.js`.)

If you find a bug, **please open a GitHub issue** with the
journal excerpt. Include the snap revision:

```bash
snap list quilt-core   # ← note the "Rev" column
quilt-core --version   # ← note the "snap revision" line
```

---

## 3. The new snap revision is bad — auto-rollback

**Symptom:** The device reboots after a refresh, then reboots
*again* within ~3 minutes. The second boot is the previous
revision.

**Cause:** The new revision's health check (snapd's
`snapdReady` + the daemon's `quilt-core configcheck`) failed.
Common reasons: bad migration in the new revision, incompatible
schema, missing plug.

**Fix:** **Nothing.** snapd has already reverted. Verify with:

```bash
snap list quilt-core    # ← should show the previous revision
quilt-core status       # ← should be healthy
journalctl -u snap.quilt-core.daemon.service -n 50
```

If the device is stuck in a revert loop (e.g. the previous
revision is *also* bad for some reason), you can pin to a known
good one:

```bash
sudo snap refresh quilt-core --revision=<known-good-rev>
```

To find a known-good revision, look at
<https://snapcraft.io/quilt-core/releases>.

---

## 4. The new revision is *slowly* bad (memory leak, drift over days)

**Symptom:** The device is up, the daemon is running, but
`quilt-core status` shows growing memory, or a cell that drifts
over time.

**Cause:** A bug that surfaces only under load or only after
many hours.

**Fix:** Two paths.

### Path A: revert manually

```bash
sudo snap revert quilt-core
```

The device stays up; only the snap is reverted. Cells are
restarted as part of the revert.

### Path B: pin to the previous revision

```bash
sudo snap refresh quilt-core --revision=<prev-rev> --hold
```

This pins the snap to the previous revision; it will not
auto-refresh even if a new one is published. Use this in
production fleets where you need to investigate before
re-upgrading.

---

## 5. The kernel/base is bad — bootloader menu

**Symptom:** The device boots to a black screen, or hangs at
the bootloader, or kernel-panics on boot.

**Cause:** A bad kernel (rare; Canonical's kernel is heavily
tested) or a bad Ubuntu Core base. Most often: an interrupted
`ubuntu-image` build that wrote a corrupt bootloader.

**Fix:**

### Pi 4/5

Hold **`Shift`** during boot (within the first 2 seconds) to
enter the bootloader menu. Choose "Boot previous slot".

### x86

Press **`Esc`** during boot to enter the bootloader menu.
Choose the previous boot entry.

### Jetson

The Jetson's bootloader is more limited. The most reliable
recovery is to **re-flash** (see section 6).

After you boot the previous slot, fix the bad boot by reverting
the snap:

```bash
sudo snap revert <snap-that-broke>
```

If you cannot identify which snap broke, look at the boot log:

```bash
sudo journalctl -k -b -1    # ← kernel log of the previous boot
```

---

## 6. Re-flash — the last resort

If the device is completely unbootable (corrupted bootloader,
dead SD card, lost the A/B layout), re-flash. **This is the
"un-brick"** part: even this worst case is recoverable in 20
minutes.

### What survives a re-flash?

| Survives | Does not survive |
|----------|-------------------|
| The SD card is OK; the bootloader is OK | The SD card is physically damaged |
| A new SD card, you re-flash, **and** you have a backup of `writable/` | The TPM-measured-boot state |
| The TPM-measured-boot state (after first boot with the new image) | A device without a TPM and with full-disk encryption keys lost |

In short: as long as the SD card itself works, you can re-flash
and restore state.

### Re-flash procedure

```bash
# 1. On the host, re-flash.
sudo ./scripts/flash-pi.sh out/quilt-core-pi4.img.xz /dev/sdX

# 2. Boot. The first boot is slow (resizing, key generation).
#    SSH in.

# 3. (optional) Restore the previous state. /var/snap/quilt-core/
#    is on the `writable` partition; if you backed it up, you can
#    copy it back. Otherwise, re-init.
sudo systemctl stop snap.quilt-core.daemon.service
sudo rsync -a /media/backup/quilt-core/ /var/snap/quilt-core/
sudo systemctl start snap.quilt-core.daemon.service
quilt-core status
```

If the `writable` partition is also gone (full SD card
corruption), `quilt-core init` will generate a new node-id and
re-register with `quilt-fleet`. The fleet will see this as a
*new* node; the old node-id is dead.

### Backing up `writable/`

Before any risky operation, snapshot `writable/`:

```bash
# On the host, with the SD card inserted but not mounted:
sudo dd if=/dev/sdX3 bs=16M status=progress | xz -9 > writable-backup.img.xz
```

(Partition 3 is the `writable` partition; on Pi 4 with the
default layout, it's the third primary partition.)

The image can be quite large (the size of the `writable`
partition, which is "everything not used by the system slots");
store it off-device.

---

## 7. The factory reset

If you want to wipe *everything* — node-id, fleet registration,
cell state, OTA pin — and start over:

```bash
sudo snap remove --purge quilt-core
sudo rm -rf /var/snap/quilt-core
# Reinstall.
sudo snap install quilt-core
sudo snap start quilt-core
quilt-core init
```

This is the equivalent of "factory reset". The OS itself
(Ubuntu Core) is untouched.

---

## 8. The un-flippable A/B slot

**Symptom:** snapd has marked one of the A/B slots as
"unhealthy" and refuses to flip back. The device is stuck on
the other slot.

**Fix:**

```bash
# Check which slot is which.
sudo snap debug boot

# Force a flip.
sudo snap revert core    # ← base snap; can't be reverted
# For our snap specifically:
sudo snap refresh quilt-core --channel=<known-good>
```

If the kernel itself is bad, you need to use the bootloader
menu (section 5).

---

## 9. Reporting a recovery failure

If the OS did *not* recover automatically when it should have,
**please report it**. That's a bug in our recovery story, and
we want to fix it.

Open a GitHub issue at
<https://github.com/SuperInstance/quilt-core-os/issues> with:

- The output of `snap version`.
- The output of `snap list quilt-core`.
- The output of `journalctl -u snap.quilt-core.daemon.service -n
  500` for the failed boot.
- The output of `snap changes` and `snap change <id>` for the
  refresh that failed.
- (If serial console is available) the kernel log from the
  failed boot.

---

## 10. Summary of the recovery guarantees

| Failure                                | Recovery time | Operator action |
|----------------------------------------|---------------|-----------------|
| Cell crash                             | < 1 s         | `quilt-core cell restart` |
| Daemon crash                           | < 30 s        | none (snapd restarts) |
| Bad snap revision                      | < 90 s        | none (auto-revert) |
| Bad kernel/base                        | < 60 s        | pick previous from bootloader menu |
| Corrupted bootloader                   | < 30 min      | re-flash |
| Dead SD card                           | < 30 min      | replace card, re-flash, restore from backup |
| Physical tampering                     | indefinite    | re-flash + revoke keys |

The last two are the only ones that *require* a person. The
rest should be invisible.

---

_Last updated: 2024-09-01_
