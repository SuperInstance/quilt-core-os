# Installing quilt-core on an NVIDIA Jetson

> **Time required:** 30–45 minutes (most of it is image build +
> flash + first boot).
>
> **Skill level:** Comfortable with a terminal; familiar with the
> Jetson flashing workflow.
>
> **What you need:**
> - An NVIDIA Jetson Orin Nano (4GB/8GB) or Orin NX (8GB/16GB)
> - A microSD card (Orin Nano dev kit) or NVMe SSD (Orin NX
>   module), 32 GB or larger
> - A USB-C cable (Jetson in recovery mode)
> - A Linux host with `bmaptool` (or `dd`), `nvidia-l4t-core` tools
> - An Ubuntu SSO account

This guide assumes you are flashing the **Orin Nano** dev kit
(the most common case). The Orin NX module is identical except
you flash to NVMe instead of SD.

---

## 1. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│   Jetson Orin Nano (or NX)                                  │
│                                                             │
│   ┌─────────────────────────────────────────────┐           │
│   │           ubuntu-core 24 (read-only)         │           │
│   │  ┌────────────┐  ┌─────────────────────┐    │           │
│   │  │ kernel     │  │ quilt-core snap     │    │           │
│   │  │ (L4T)      │  │  (TypeScript daemon)│    │           │
│   │  └────────────┘  └────────┬────────────┘    │           │
│   │                          │                 │           │
│   │  ┌───────────────────────▼──────────────┐  │           │
│   │  │  GPU runtime (CUDA + TensorRT +     │  │           │
│   │  │  cuDNN) — provided by L4T base      │  │           │
│   │  └──────────────────────────────────────┘  │           │
│   └─────────────────────────────────────────────┘           │
│                          │                                  │
│                          ▼                                  │
│                  ┌──────────────┐                           │
│                  │  Cell(s)     │ ← quilt-jetson provides  │
│                  │  (TensorRT)  │   GPU kernels for cells   │
│                  └──────────────┘                           │
└─────────────────────────────────────────────────────────────┘
```

The Jetson-specific bits live in **[quilt-jetson](https://github.com/SuperInstance/quilt-jetson)**;
this repo provides the immutable OS layer (Ubuntu Core) and the
Quilt daemon.

---

## 2. Prerequisites

Install the host-side tooling:

```bash
# On Ubuntu 22.04 or 24.04:
sudo apt install \
  bmaptool \
  python3-minimal \
  udev \
  android-tools-adb \
  abootimg \
  binutils

# nvidia-l4t tools. On Ubuntu:
sudo apt install nvidia-l4t-core

# Or from the Jetson Linux package directly:
# https://developer.nvidia.com/embedded/jetson-linux
```

You also need to be in the `dialout` and `plugdev` groups so you
can talk to the Jetson over USB without `sudo`:

```bash
sudo usermod -aG dialout,plugdev "$USER"
newgrp dialout
```

---

## 3. Build the Quilt Jetson image

The Quilt-customized Ubuntu Core image for Jetson includes
quilt-core, the L4T kernel, and the CUDA userland.

```bash
git clone https://github.com/SuperInstance/quilt-core-os
cd quilt-core-os
./scripts/build-image.sh jetson
```

This produces `quilt-core-jetson.img.xz` (~ 1.5 GB compressed,
~ 6 GB uncompressed).

If you also want the GPU runtime snap (CUDA + TensorRT +
cuDNN), pass it as an extra snap:

```bash
./scripts/build-image.sh jetson \
  --extra-snap=quilt-jetson-runtime
```

The `quilt-jetson-runtime` snap is published in the SuperInstance
brand store. See <https://github.com/SuperInstance/quilt-jetson>.

---

## 4. Flash the image

### Orin Nano dev kit (microSD)

```bash
# Find the SD card.
lsblk
# → /dev/sdX

# Flash.
sudo ./scripts/flash-pi.sh out/quilt-core-jetson.img.xz /dev/sdX
```

### Orin NX module (NVMe SSD)

The Orin NX module does not have an SD slot; you must flash to
NVMe. The `flash-pi.sh` script handles that too, but the
destination device is different.

```bash
# Remove the bottom cover, plug the NVMe SSD into the M.2 slot.
# Put the Jetson into recovery mode: hold REC, press RST, release REC.
# Connect the Jetson to your host via USB-C.

lsusb
# → "NVIDIA Corp. APX" should appear

# Now flash. The Jetson exposes a "virtual" block device over
# USB; the path is /dev/sdX on most hosts.
sudo ./scripts/flash-pi.sh out/quilt-core-jetson.img.xz /dev/sdX
```

If `flash-pi.sh` does not see the device, fall back to
`nvidia-l4t-bootloader`'s `flash.sh`:

```bash
sudo /opt/nvidia/l4t-bootloader/flash.sh \
  -d /dev/sdX \
  -c bootloader/t210ref/cfg/flash_t234_qspi.xml \
  out/quilt-core-jetson.img
```

---

## 5. First boot

1. Connect the Jetson to a display via HDMI/DP.
2. Connect a USB keyboard.
3. Connect Ethernet.
4. Power on.

First boot takes **~2 minutes** on Jetson (slower than Pi
because of the larger image and the GPU driver init).

The Jetson will:

- Initialize the GPU.
- Resize the writable partition.
- Print an `ubuntu@<ip>` line for SSH.

### SSH into the device

```bash
ssh ubuntu@ubuntu-core-<serial>.local
```

If mDNS is not available, check the IP from your router or the
serial console (the Jetson dev kit exposes a serial console over
the micro-USB port next to the USB-C port; use `picocom -b
115200 /dev/ttyUSB3` or similar).

---

## 6. Verify the GPU

```bash
# Check that the GPU is visible.
sudo /usr/sbin/tegrastats --interval 1000

# Check that CUDA sees the device.
ls /dev/nvidia*

# Check that TensorRT is loadable.
python3 -c "import tensorrt; print(tensorrt.__version__)"

# Check the cell runtime.
quilt-core status
```

You should see GPU utilisation at 0% (idle) and a `cells: 0`
line. To start a GPU-accelerated cell:

```bash
sudo snap install quilt-jetson-runtime --channel=stable
quilt-core cell start --id=gpu-demo \
  --command=quilt-jetson-cell \
  --args=--model=llama-3.1-8b-int4
quilt-core cell logs gpu-demo
```

The cell will report GPU utilisation rising as it warms up.

---

## 7. Power & performance tuning

Jetson Orin Nano supports several power modes. The Quilt image
defaults to `mode 0` (15 W). For more headroom:

```bash
sudo /usr/sbin/nvpmodel -m 1    # 25 W
# Or for max performance (Orin NX only):
sudo /usr/sbin/nvpmodel -m 2    # 40 W
```

To set the clock speeds manually:

```bash
sudo jetson_clocks
```

Add the desired `nvpmodel` and `jetson_clocks` invocations to
`/var/snap/quilt-core/common/state/power-profile` (a simple
text file parsed by a Quilt hook). The next reboot will apply
the profile.

---

## 8. Recovery

See [recovery.md](recovery.md). Jetson-specific gotchas:

- **The Jetson is in recovery mode after a bad flash.** Plug in
  USB-C; `lsusb` should show "NVIDIA Corp. APX". From there you
  can re-flash.
- **NVMe corruption** can leave the device unbootable. The
  gadget's A/B layout does **not** cover NVMe wear-out; you
  should monitor SMART attributes with `sudo smartctl -a
  /dev/nvme0n1` and replace the SSD proactively.
- **GPU hangs** ("NVRM: Xid") are usually a sign of a bad
  kernel module or an over-clocked GPU. `sudo journalctl -k |
  grep NVRM` for the Xid code, then look it up in the
  [NVIDIA documentation](https://docs.nvidia.com/jetson/l4t/).

---

## 9. Cross-references

- **[quilt-jetson](https://github.com/SuperInstance/quilt-jetson)** —
  GPU runtime, TensorRT bindings, model zoo.
- **[install-raspberry-pi.md](install-raspberry-pi.md)** — the Pi
  guide has more detail on the snap-based update flow.
- **[../SECURITY.md](../SECURITY.md)** — the security model.

---

_Last updated: 2024-09-01_
