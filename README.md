# quilt-core-os

```
  ██████  ██    ██ ██ ██      ████████  ██████  ██████  ███████
  ██   ██ ██    ██ ██ ██         ██    ██    ██ ██   ██ ██
  ██   ██ ██    ██ ██ ██         ██    ██    ██ ██████  █████
  ██   ██  ██  ██  ██ ██         ██    ██    ██ ██   ██ ██
  ██████    ████   ██ ███████    ██     ██████  ██   ██ ███████

  ──────────── core operating system ────────────
  Immutable · Atomic · Un-brickable
```

**Immutable, snap-based Ubuntu Core appliance for Quilt edge deployment.**
**Atomic OS updates with instant rollback. Un-brickable by design.**

> Ship Quilt to the edge on a Raspberry Pi, Jetson, or any amd64 box, then
> never worry about it again. The OS is read-only. Updates are transactional.
> Power loss mid-update? Reboot — the device rolls back to the last good
> state on its own. Bricked? Re-flash the SD card and restore state from
> `quilt-fleet`. **There is no brick mode.**

---

## Table of contents

- [Why](#why)
- [Quick start](#quick-start)
- [Architecture](#architecture)
- [Snap confinement](#snap-confinement)
- [OTA updates](#ota-updates-snap-store--edge-channel)
- [Snap vs Docker vs apt](#snap-vs-docker-vs-traditional-packages)
- [Supported hardware](#supported-hardware)
- [Repository layout](#repository-layout)
- [Cross-references](#cross-references)
- [Building](#building)
- [Recovery](#recovery)
- [License](#license)

---

## Why

Edge devices in the Quilt ecosystem run in places humans forget about:
solar-powered gateways, factory floors, in-vehicle compute, marine buoys.
When something goes wrong at 03:00 you cannot drive out and re-image a Pi.
You need:

- **Immutability** — `/` is read-only. No stray `apt install` from a tired
  engineer at midnight permanently changing the system.
- **Atomicity** — Updates are all-or-nothing. There is no half-installed
  state. The kernel, the snap base, and the Quilt daemon all swap together.
- **Auto-rollback** — If the new boot fails (kernel panic, daemon crash,
  health check fail) Ubuntu Core reverts to the previous boot in seconds.
  No human intervention.
- **Signed images** — Every update is signed. The bootloader refuses to
  boot anything it cannot cryptographically verify.
- **No brick mode** — A/B partitions mean there is always a known-good
  system to fall back to. Even an attacker with physical access cannot
  permanently break a Quilt device.

This repo packages Quilt as a [snap](https://snapcraft.io) and provides the
gadget definitions and build scripts to ship a custom Ubuntu Core image
with Quilt pre-installed.

---

## Quick start

### 1. Install Ubuntu Core on a Raspberry Pi

Download the official Ubuntu Core image for your Pi from
<https://ubuntu.com/download/raspberry-pi>, flash it to an SD card, boot
the Pi, and follow the on-screen setup (it will ask you to log in with
your Ubuntu SSO account).

Or, to use the Quilt-customized image from this repo:

```bash
git clone https://github.com/SuperInstance/quilt-core-os
cd quilt-core-os
./scripts/build-image.sh pi4          # produces quilt-core-pi4.img.xz
./scripts/flash-pi.sh quilt-core-pi4.img.xz /dev/sdX
```

Boot the Pi. Quilt is already installed and starts on first boot.

### 2. (Manual install path) install the Quilt snap

```bash
sudo snap install quilt-core --edge
sudo snap start quilt-core
```

### 3. Initialize the local node

```bash
quilt-core init
```

This generates a node identity, registers with `quilt-fleet`, and starts
the local cell runtime. See the [architecture section](#architecture) for
what each step does.

### 4. Verify

```bash
quilt-core status          # daemon health
quilt-core cell list       # running Quilt cells
quilt-core fleet ping      # is this node visible to the fleet controller?
```

Done. The OS is now immutable, updates are atomic, and you can `snap
refresh` from anywhere with no risk.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                  Quilt appliance (Pi / Jetson / x86)         │
│                                                              │
│  ┌───────────────────────────────────────────────────────┐  │
│  │              Ubuntu Core (read-only root)              │  │
│  │                                                       │  │
│  │   core24 base  ─── kernel + gadget snap               │  │
│  │       │                                               │  │
│  │       ▼                                               │  │
│  │   quilt-core snap  (THIS PACKAGE)                     │  │
│  │       │                                               │  │
│  │       ├── quilt-core daemon  (TypeScript)             │  │
│  │       │     │   ▲                                      │  │
│  │       │     │   └──── unix socket @ $SNAP_DATA/sock    │  │
│  │       │     ▼                                         │  │
│  │       ├── state.ts   ─── SQLite (cells, telemetry)    │  │
│  │       ├── ota-checker.ts  ─── channel refresh loop    │  │
│  │       │                                               │  │
│  │       └─► cell runtime  (managed subprocess)          │  │
│  │              │                                        │  │
│  │              ▼                                        │  │
│  │       local AI / model calls (quilt-base)             │  │
│  │              │                                        │  │
│  │       ┌──────┴──────┐                                 │  │
│  │       ▼             ▼                                 │  │
│  │   ESP32 mesh    Jetson peer                           │  │
│  │   (quilt-esp32) (quilt-jetson)                        │  │
│  └───────────────────────────────────────────────────────┘  │
│                          │                                   │
│                          ▼                                   │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  Snapd — A/B partitions, transactional refresh,       │  │
│  │  signed assertions, automatic rollback on bad boot     │  │
│  └───────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
                          │
                          ▼
                  ┌──────────────────┐
                  │   quilt-fleet    │  (control plane)
                  │   (out of band)  │
                  └──────────────────┘
```

### Component responsibilities

| Component                  | Lives in      | Responsibility                                    |
|----------------------------|---------------|---------------------------------------------------|
| Ubuntu Core base           | gadget snap   | Read-only OS, kernel, A/B partitions              |
| `quilt-core` snap          | this repo     | Quilt runtime: cells, state, OTA, IPC             |
| `quilt-core` daemon        | `src/daemon.ts` | unix-socket service managing local cells        |
| State store                | `src/state.ts` | SQLite in `$SNAP_DATA/state.db`                   |
| OTA checker                | `src/ota-checker.ts` | polls snap store, signs, verifies         |
| Cell runtime               | spawned       | one per Quilt cell (model, tool, etc.)            |

### Data flow

1. The daemon listens on `$SNAP_DATA/run/quilt-core.sock`.
2. `quilt-core` (the CLI shim) connects, RPCs commands, returns.
3. Each Quilt cell runs as a managed subprocess; stdout/err are
   captured, state updates are persisted to SQLite.
4. OTA checker wakes every N minutes, polls the configured snap
   channel (default: `edge`), and asks snapd to refresh if a newer
   revision is available.
5. On `snap refresh`, snapd swaps to a new base+quilt-core in a
   single transactional step. If the new boot fails the kernel
   health-check, snapd automatically reverts to the prior
   revision. **No human in the loop.**

---

## Snap confinement

`quilt-core` runs under **strict** confinement. The snap has no
unmediated access to the host. Inter-process communication is via
snapd's mediated interfaces, called **plugs**.

```yaml
# snap/snapcraft.yaml
confinement: strict
plugs:
  network          # outbound HTTPS to snap store, quilt-fleet
  network-bind     # open the cell IPC socket
  firewall-control # manage iptables/nftables for cell sandboxes
  home             # read ~/.quilt/ for user config
  system-observe   # device telemetry: CPU, temp, memory
  opengl           # GPU on Pi 4/5 and Jetson
  raw-usb          # ESP32 mesh via serial
  serial-port      # modem, RS-485 sensors
  bluez            # BLE peripherals (optional)
  removable-media  # /media for offline cell bundles
  shutdown         # clean cell shutdown on reboot
```

Plugs are *requests*; the user (or a brand store) must connect them
explicitly with `snap connect`. The Quilt-customized Ubuntu Core
image in this repo pre-connects the safe default set so the device
works out of the box.

### Why strict confinement matters here

A Quilt appliance may run in adversarial settings — public spaces,
untrusted networks, even physical access. Strict confinement means
even a compromised Quilt cell cannot:

- Read another snap's data.
- Modify `/etc`, the kernel, or boot loader.
- Bind privileged ports or sniff other processes.

The blast radius of a Quilt-cell bug is the cell, not the device.

---

## OTA updates (snap store, edge channel)

`quilt-core` is published to the snap store under the
`superinstance` publisher. Updates flow over the same signed
assertion mechanism Ubuntu Core uses for the kernel and base.

```
┌────────────┐         ┌─────────────┐        ┌──────────────┐
│  CI builds │ ─push─▶ │  snap store │ ─poll─▶│  OTA checker  │
│  quilt-core│         │  (edge)     │        │  in daemon    │
└────────────┘         └─────────────┘        └──────┬───────┘
                                                      │
                                              snapd refresh
                                                      │
                                                      ▼
                                              new A/B slot
                                                      │
                                            reboot + health
                                                check
                                              ┌───┴───┐
                                              ▼       ▼
                                              ok    fail → revert
```

### How a refresh actually works

1. `snap refresh --channel=edge quilt-core` (manual, or auto via the
   OTA checker) downloads the new snap.
2. snapd stages it in the *alternate* A/B slot. The running system
   is untouched.
3. snapd schedules a reboot.
4. The bootloader boots the new slot.
5. snapd runs the `install` hook (if first install) or `upgrade`
   hook (if upgrade).
6. A health check runs (`quilt-core ready` over the unix socket).
   If it returns 0 within the timeout, the new slot is marked
   good and persisted.
7. If anything goes wrong — kernel panic, daemon crash, health
   check timeout, power loss — snapd reverts to the previous slot
   on the next boot. **This is the un-brickable part.**

### Channel strategy

| Channel | Use                                            |
|---------|------------------------------------------------|
| `edge`  | bleeding edge, daily CI builds                 |
| `beta`  | pre-release, weekly                            |
| `stable`| tagged releases, recommended for fleet        |

`quilt-fleet` pins individual nodes (or node groups) to a channel
or a specific revision. A pinned revision never auto-refreshes
even if a new one is published — this is the gold standard for
production fleets.

### What can go wrong

- A new revision is bad → snapd reverts automatically.
- A new revision is *slowly* bad (memory leak, drift over days) →
  `quilt-fleet` notices the health endpoint is red and reverts
  the snap revision remotely.
- A new revision is bad AND breaks the health check → see above.
- The device is in a reboot loop → snapd stops booting the bad
  slot after 3 attempts and reverts.

There is no scenario where a `snap refresh` permanently bricks the
device. That guarantee is the whole point of this repo.

---

## Snap vs Docker vs traditional packages

| Concern                       | apt + .deb         | Docker            | snap (this repo)       |
|-------------------------------|--------------------|-------------------|------------------------|
| **Atomic updates**            | no — package-by-pkg| image swap        | yes — full OS swap     |
| **Auto rollback**             | no                 | manual            | yes — A/B on every boot|
| **Power-loss safe**           | no                 | depends           | yes — transactional    |
| **Signed updates**            | apt-key (legacy)   | image signing     | signed assertions      |
| **Confinement**               | none               | namespace, weak   | AppArmor + seccomp      |
| **Immutability**              | no                 | partial           | yes — read-only root   |
| **Multi-arch (Pi, x86, arm64)**| yes              | yes               | yes (one snap, all arch)|
| **Delta updates**             | no                 | layer cache       | yes                    |
| **OS independence**           | ties to host OS    | containers share kernel | snap carries base  |
| **Footprint**                 | small              | medium            | medium                 |
| **Right tool for**            | dev workstation    | stateless service | edge appliance         |

Use Docker when you need cloud-portable stateless services. Use
snap + Ubuntu Core when you need an **appliance**: turn-key, update
in place, and recoverable from any failure.

---

## Supported hardware

| Board                        | Gadget           | Status        |
|------------------------------|------------------|---------------|
| Raspberry Pi 4 (1GB/2GB/4GB/8GB) | `gadget/pi4.yaml` | ✅ stable |
| Raspberry Pi 5 (4GB/8GB)     | `gadget/pi5.yaml` | ✅ stable    |
| NVIDIA Jetson Orin Nano      | `gadget/jetson.yaml` | ✅ stable |
| Generic amd64 (NUC, MiniPC)  | base amd64       | ✅ stable    |
| NVIDIA Jetson Xavier NX      | jetson-orin      | 🚧 community |
| Raspberry Pi 3               | pi3 (use official image) | ⚠️ legacy |

All gadgets ship the same `quilt-core` snap; only the kernel,
bootloader, and device-tree differ.

---

## Repository layout

```
quilt-core-os/
├── README.md                  ← you are here
├── LICENSE                    Apache-2.0
├── SECURITY.md                update + signing policy
├── snap/                      snapcraft definition + hooks
│   ├── snapcraft.yaml
│   ├── hooks/
│   │   ├── install            first-time install
│   │   ├── configure          config changed
│   │   └── upgrade            snap upgrade
│   └── local-bin/
│       └── quilt-core         CLI shim → daemon
├── src/                       TypeScript daemon
│   ├── daemon.ts              unix-socket service
│   ├── state.ts               SQLite state store
│   └── ota-checker.ts         channel poll loop
├── scripts/                   build helpers
│   ├── build-snap.sh          build the snap locally
│   ├── build-image.sh         build a custom Ubuntu Core image
│   └── flash-pi.sh            flash the image to an SD card
├── gadget/                    Ubuntu Core gadget definitions
│   ├── pi4.yaml
│   ├── pi5.yaml
│   └── jetson.yaml
├── docs/                      human guides
│   ├── install-raspberry-pi.md
│   ├── install-jetson.md
│   └── recovery.md
└── .github/
    ├── workflows/build.yml    CI: lint, test, build, publish
    ├── dependabot.yml
    └── CODEOWNERS
```

---

## Cross-references

`quilt-core-os` is the immutable OS layer. It depends on and is
composed with the rest of the Quilt ecosystem:

- **[quilt-base](https://github.com/SuperInstance/quilt-base)** — the
  core AI runtime. `quilt-core` spawns cells that load `quilt-base`.
- **[quilt-jetson](https://github.com/SuperInstance/quilt-jetson)** —
  the Jetson-specific companion. Provides GPU kernels and TensorRT
  bindings. Layered on top of the same snap.
- **[quilt-esp32](https://github.com/SuperInstance/quilt-esp32)** —
  the ESP32 mesh firmware. Talks to the daemon over `raw-usb` and
  `serial-port` plugs.
- **[quilt-elf](https://github.com/SuperInstance/quilt-elf)** — the
  embedded Linux distribution for sub-Pi devices. Not snap-based
  (no MMU), but uses the same protocol on the wire.
- **[quilt-fleet](https://github.com/SuperInstance/quilt-fleet)** —
  the control plane. Pushes channel pins, fetches telemetry, rolls
  out staged updates.

`quilt-core` is the *device-side runtime*; `quilt-fleet` is the
*cloud-side controller*. They are deliberately separate so a
fleet of 10,000 devices can be rolled out in waves without ever
touching them by hand.

---

## Building

### Local snap build

```bash
sudo apt install snapcraft
./scripts/build-snap.sh              # → quilt-core_*.snap
sudo snap install --dangerous quilt-core_*.snap
```

### Custom Ubuntu Core image

```bash
sudo snap install ubuntu-image
./scripts/build-image.sh pi4         # → quilt-core-pi4.img.xz
./scripts/build-image.sh pi5         # → quilt-core-pi5.img.xz
./scripts/build-image.sh jetson      # → quilt-core-jetson.img.xz
```

The image has Quilt pre-installed and a sane default config. Flash
with `flash-pi.sh` (or `bmaptool` on Jetson).

### CI

`.github/workflows/build.yml` builds on every push to `main`,
tests on `amd64` and `arm64`, and pushes to the snap store's
`edge` channel. Tags push to `stable`.

---

## Recovery

See [docs/recovery.md](docs/recovery.md). TL;DR:

1. Boot bad? snapd reverts automatically. Wait 90 seconds.
2. Still bad? Boot the previous kernel from the bootloader menu
   (hold `shift` on Pi at boot, or ` Esc ` on x86).
3. Catastrophic corruption? Re-flash the SD card. The state DB
   is on `writable` partition, so it survives unless the
   partition table is gone.
4. State DB lost? Re-run `quilt-core init` and re-register with
   `quilt-fleet`. Cells will re-sync.

---

## License

Apache License 2.0. See [LICENSE](LICENSE).

Copyright 2024-2026 SuperInstance Contributors.
