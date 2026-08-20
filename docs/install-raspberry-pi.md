# Installing quilt-core on a Raspberry Pi

> **Time required:** 20–30 minutes (most of it is `xz`-decompressing
> the image to the SD card).
>
> **Skill level:** Comfortable with a terminal; able to identify
> `/dev/sdX` correctly.
>
> **What you need:**
> - A Raspberry Pi 4 (1/2/4/8 GB) or Pi 5 (4/8 GB)
> - A microSD card, 16 GB or larger, **A1-rated or better**
> - A card reader
> - A Linux, macOS, or Windows host with `bmaptool` (or `dd` + `xz`)
> - An Ubuntu SSO account (free): <https://login.ubuntu.com>
> - A monitor + keyboard for the first boot, OR a router that
>   supports mDNS (most do)

---

## 1. Choose an image

You have two options:

### Option A — the official Ubuntu Core image (recommended for a quick start)

Download the official image for your Pi from
<https://ubuntu.com/download/raspberry-pi>:

| Board | URL                                                                          |
|-------|------------------------------------------------------------------------------|
| Pi 4  | <https://cdimage.ubuntu.com/ubuntu-core/24/stable/current/ubuntu-core-24-core-arm64+raspi.img.xz> |
| Pi 5  | <https://cdimage.ubuntu.com/ubuntu-core/24/stable/current/ubuntu-core-24-core-arm64+raspi-5b.img.xz> |

Then install the `quilt-core` snap from the store (step 4 below).

### Option B — a Quilt-customized image (recommended for fleets)

Build it yourself:

```bash
git clone https://github.com/SuperInstance/quilt-core-os
cd quilt-core-os
./scripts/build-image.sh pi4       # or `pi5`
```

The output is `quilt-core-pi4.img.xz` (or `…-pi5.img.xz`). The
snap is already pre-installed and pre-configured; you can skip
step 4 below.

---

## 2. Flash the image

```bash
# Find your SD card device.
lsblk
# (look for /dev/sdX or /dev/mmcblk0; double-check!)

# Flash. This will OVERWRITE the target device.
sudo ./scripts/flash-pi.sh out/quilt-core-pi4.img.xz /dev/sdX
```

The `flash-pi.sh` script handles decompression, bmap-based copy
(only writes the used blocks, so it is *much* faster than `dd`),
and a final sync.

If you don't have `bmaptool`:

```bash
xz -dc out/quilt-core-pi4.img.xz | sudo dd of=/dev/sdX bs=16M status=progress conv=fsync
sync
```

---

## 3. First boot

1. Insert the SD card into the Pi.
2. Connect the Pi to your router with an Ethernet cable (Wi-Fi
   configuration is **not** supported on first boot).
3. Connect a monitor + keyboard (or rely on mDNS for SSH).
4. Power on the Pi.

The first boot takes **~90 seconds**. The Pi will:

- Resize the writable partition to fill the SD card.
- Generate a device key.
- Print a `ubuntu@<ip-address>` line for SSH.

If you have a monitor attached, follow the on-screen prompts to
link the device to your Ubuntu SSO account. If you don't, the
device will print a one-time code on its console; enter that at
<https://login.ubuntu.com> to authorize it.

### SSH into the device

The default user is `ubuntu`. Password is **not** set; you must
use the SSH key you registered with your Ubuntu SSO account.

```bash
# The hostname is `ubuntu-core-<serial>`. mDNS is enabled.
ssh ubuntu@ubuntu-core-2c:3f:45.local
```

(Replace `2c:3f:45` with the serial number printed on the boot
console.)

---

## 4. Install the Quilt snap

If you used the **official** Ubuntu Core image in step 1:

```bash
sudo snap install quilt-core --channel=stable
sudo snap start quilt-core
```

If you used the **Quilt-customized** image, the snap is already
installed. Verify with:

```bash
snap list quilt-core
quilt-core --version
```

---

## 5. Initialize the node

```bash
quilt-core init
```

You will be prompted for:

- The **fleet URL** (default: `https://fleet.superinstance.io`).
- The **node name** (default: the Pi's serial number).
- Whether to enable **telemetry** to the fleet (default: yes).
- Whether to enable **auto-OTA** on the `edge` channel (default:
  yes for dev, no for production).

This generates a `node-id` (UUID) stored at
`/var/snap/quilt-core/common/state/node-id` and registers the
node with `quilt-fleet`. **The node-id is permanent; do not
delete it.** It is how the device identifies itself across
reboots, refreshes, and re-flashes (as long as `writable/` is
intact).

---

## 6. Verify

```bash
quilt-core status
```

You should see something like:

```
quilt-core 1.2.3 (snap revision 42)
  uptime:    12s
  nodeId:    a3b1c2d4-…
  arch:      arm64
  cells:     0
  ota:
    running: true
    channel: stable
    pinned:  false
  fleet:
    url:    https://fleet.superinstance.io
    ok:     true
```

If `cells: 0` and you want to launch one:

```bash
quilt-core cell start --id=demo --command=quilt-base --args=--model=llama-3.1-8b
quilt-core cell list
quilt-core cell logs demo
```

---

## 7. Configure

`quilt-core` is configured via `snap set`:

```bash
sudo snap set quilt-core ota-channel=stable
sudo snap set quilt-core ota-interval=6h
sudo snap set quilt-core log-level=info
sudo snap set quilt-core fleet-url=https://fleet.example.com
sudo snap set quilt-core cell-port=9090
sudo snap set quilt-core telemetry-port=9100
```

After each `snap set`, the `configure` hook validates the
values, persists them to `/var/snap/quilt-core/common/state/config.json`,
and restarts the daemon.

To see all current settings:

```bash
sudo snap get quilt-core -d
```

---

## 8. Update

```bash
# Manual update.
sudo snap refresh quilt-core

# Watch the boot decision.
journalctl -u snap.quilt-core.daemon.service -f
```

If the new revision is bad, snapd reverts automatically. Watch
for:

```
[ota] new revision available: 42 → 43 on stable
[ota] refresh requested
…
snapd is reverting snap quilt-core to revision 42   (← this means it failed)
```

To pin to a specific revision (the gold standard for production):

```bash
sudo snap refresh quilt-core --revision=42
# Or via fleet:
quilt-fleet nodes pin <node-id> --revision=42
```

---

## 9. Troubleshooting

### The Pi does not boot (no HDMI output)

- Is the SD card inserted correctly? (Contacts down.)
- Try a different SD card; slow cards are the #1 cause of failed
  first boots.
- Is the Pi receiving enough power? Use the official PSU; USB
  hubs are unreliable for first boot.
- Re-flash with `--verbose` to see if the write succeeded.

### I cannot SSH into the Pi

- Is mDNS working? `avahi-browse -a` on the host should show
  `ubuntu-core-…`. If not, find the IP from your router's DHCP
  table.
- Did you upload your SSH key to Ubuntu SSO?
  <https://login.ubuntu.com/ssh-keys>
- The Pi may be stuck at the "press a key to configure" prompt
  if you have a monitor attached. Press Enter.

### `quilt-core init` says "snap not connected"

You need to connect the plugs. The Quilt-customized image does
this for you; the official image does not. Connect them with:

```bash
sudo snap connect quilt-core:network
sudo snap connect quilt-core:network-bind
sudo snap connect quilt-core:firewall-control
sudo snap connect quilt-core:home
sudo snap connect quilt-core:system-observe
```

(See `snap connections quilt-core` for the full list.)

### How do I factory-reset?

```bash
sudo snap revert quilt-core                       # back to previous revision
# Or, to wipe state and re-init:
sudo systemctl stop snap.quilt-core.daemon.service
sudo rm -rf /var/snap/quilt-core/common/state
sudo snap start quilt-core
quilt-core init
```

### How do I get a serial console?

Add to `/var/snap/console-conf/config.toml` on the `writable`
partition (not in the read-only snap):

```toml
[boot]
serial = "ttyS0,115200"
```

Reboot. You'll get a console on the GPIO UART pins (Pi 4: pins
8/10, GND: pin 6).

---

## 10. Next steps

- Read [recovery.md](recovery.md) for what to do when things go
  wrong.
- Read [../SECURITY.md](../SECURITY.md) for the security model.
- Read [../README.md](../README.md) for the architecture overview.

Happy edge-computing!
