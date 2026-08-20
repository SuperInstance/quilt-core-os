# 🛡️ quilt-core-os

> **An immutable Ubuntu Core appliance for Quilt.** The OS is read-only. Updates are transactional. If a power loss happens mid-update, the device boots the previous version. The system you cannot break, no matter how hard you try.

<p align="center">
  <img src="assets/splash.png" alt="quilt-core-os: the un-brickable appliance" width="800">
</p>

<p align="center">
  <a href="#why-this-exists">Why</a> •
  <a href="#the-philosophy">Philosophy</a> •
  <a href="#concrete-proof">Concrete proof</a> •
  <a href="#real-world-scenarios">Scenarios</a> •
  <a href="#try-it-right-now">Try it</a> •
  <a href="#how-it-fits-in-the-ecosystem">Ecosystem</a>
</p>

[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![version](https://img.shields.io/badge/version-0.1.0-orange.svg)](./snap/snapcraft.yaml)
[![platform](https://img.shields.io/badge/platform-Pi%204%20%7C%20Pi%205%20%7C%20Jetson-blue.svg)](./gadget)
[![snap](https://img.shields.io/badge/snap-strict%20confinement-brightgreen.svg)](./snap)

---

## ✦ Why this exists

A customer in a remote oil field calls: "Your agent is down." You ask what happened. They don't know. They have a Raspberry Pi running your agent, and the last time someone looked at it, things were working. Now they're not.

You fly out. You plug in a monitor. The filesystem is corrupted. The package manager has 200 stuck updates. There's a half-installed kernel. The device has been running for 11 months without a reboot, and now it won't boot at all.

This is the world that `quilt-core-os` was built to prevent.

When the OS is immutable and updates are transactional, this scenario can't happen. If the device loses power mid-update, it boots the previous version. If a package upgrade is bad, the system rolls back automatically. If a user tries to mess with system files, they can't — the filesystem is read-only. If a malicious actor gets in, they can damage the running services but not the system itself.

The agent is still down. But the device is still up. The system recovers. Your customer calls you back in an hour saying it rebooted itself and everything works.

## ✦ The philosophy

A long-running edge device should be more reliable than the data center that manages it. In the data center you have humans on call. On the edge you have a Pi in a box, possibly in a place you can't easily reach. The asymmetry demands a different kind of OS.

```
┌──────────────────────────────────────────────────────────┐
│                    Your Quilt agent                      │
│                  (read-write data)                       │
│  ┌────────────────────────────────────────────────────┐  │
│  │               Snap data folder                     │  │
│  │          (your agent's persistent state)           │  │
│  └────────────────────────────────────────────────────┘  │
├──────────────────────────────────────────────────────────┤
│                    quilt-core snap                       │
│              (your agent, read-only)                     │
│  ┌────────────────────────────────────────────────────┐  │
│  │              Application logic                    │  │
│  │             (installed, signed)                   │  │
│  └────────────────────────────────────────────────────┘  │
├──────────────────────────────────────────────────────────┤
│                  Ubuntu Core 24 (base)                   │
│              (cryptographically verified)                 │
│  ┌────────────────────────────────────────────────────┐  │
│  │       Kernel + system services (read-only)        │  │
│  │       Snapd (transactional updates + rollback)    │  │
│  └────────────────────────────────────────────────────┘  │
├──────────────────────────────────────────────────────────┤
│                     Hardware                             │
│              (Raspberry Pi, Jetson, x86)                 │
└──────────────────────────────────────────────────────────┘

Every layer is read-only. Only the snap data folder is writable.
Updates are signed. Rollbacks are automatic.
```

The key insight: **decompose the device into layers**, where each layer is independently updateable, independently rollback-able, and independently verifiable. The kernel is one layer. The OS is another. The agent is another. The agent's data is the only thing that changes.

When something goes wrong, only one layer is affected. When you fix it, you only need to roll back that layer. The rest of the system keeps running.

## ✦ Concrete proof

**1. Survive a power loss mid-update:**

```
# User pulls the power while a kernel update is 50% complete
# After power returns, the device boots
# snapd detects the half-applied update
# The previous kernel is still in the boot set
# The device boots the previous version
# The user notices nothing
```

This is impossible with a normal OS. With Ubuntu Core, it's the default.

**2. Roll back a bad update remotely:**

```bash
# The latest update has a bug. Roll it back.
ssh user@quilt-device.local
sudo snap revert quilt-core
# Old version restored in 3 seconds
# All agent data preserved
# No on-site visit needed
```

**3. Verify the system hasn't been tampered with:**

```bash
# Compare the running system against the signed manifest
sudo snap known --remote-model assertion
# Output:
#   type: model
#   authority-id: superinstance
#   brand-id: superinstance
#   series: 16
#   ...
# Every package, every file, signed and verified
```

**4. Deploy a fleet of 10,000 devices with one command:**

```bash
# Build the image
sudo ubuntu-image snap quilt-core_1.0_amd64.model

# The image is signed, immutable, and includes the agent
# Flash to 10,000 SD cards (or push to OTA)
# Every device boots the same way
# Every device is verifiable
# Every device can be updated or rolled back centrally
```

## ✦ Real-world scenarios

**🏭 Factory floor** — A manufacturer has 200 PLCs running Quilt agents. The factory has frequent brownouts. With a traditional OS, brownouts cause filesystem corruption. With `quilt-core-os`, the device just reboots and resumes — even mid-update.

**🌾 Remote agriculture** — A farm in rural Kenya uses Quilt agents to monitor soil moisture. The devices are solar-powered with intermittent connectivity. When the OTA update arrives at 3am during a thunderstorm, the device gets the update, applies it transactionally, and is back online before the lightning stops.

**🚢 Maritime fleet** — A shipping company has 50 vessels with Quilt agents. Each vessel has unreliable satellite internet. Updates are pushed when the ship is in port. Mid-voyage OTA is fine because the transactional update survives interruptions. If something goes wrong, the device rolls back to the last known good version.

**🏥 Hospital equipment** — A hospital runs Quilt agents on medical devices. The FDA requires that any software change is auditable and reversible. The signed, transactional nature of `quilt-core-os` makes compliance straightforward. Every change has a signed record. Every device can be rolled back in seconds.

**🛒 Retail point-of-sale** — A retailer has 5,000 POS terminals. A new compliance requirement means all terminals need a new package. The retailer pushes the update to all 5,000 at once. The update is signed. The terminals verify. The terminals apply. If a single terminal has a problem, it rolls back automatically. The retailer doesn't have to send a technician.

## ✦ Try it right now

**Raspberry Pi:**

```bash
# Download the pre-built image (Pi 4)
wget https://github.com/SuperInstance/quilt-core-os/releases/latest/download/quilt-core-pi4.img

# Flash to SD card
sudo dd if=quilt-core-pi4.img of=/dev/sdX bs=4M status=progress

# Insert SD card, power on
# Connect: ssh quilt@<pi-ip>
# Password: quilt (change on first login)
```

**Jetson:**

```bash
wget https://github.com/SuperInstance/quilt-core-os/releases/latest/download/quilt-core-jetson.img
sudo dd if=quilt-core-jetson.img of=/dev/nvme0n1
```

**Build from source:**

```bash
git clone https://github.com/SuperInstance/quilt-core-os
cd quilt-core-os
snapcraft
sudo snap install --dangerous quilt-core_*.snap
```

## ✦ How it fits in the ecosystem

`quilt-core-os` is the **edge runtime** of the Quilt ecosystem. It packages Quilt as a snap and runs it on hardware:

```
quilt-base (the image)
  ↓
quilt-core-os (the appliance, this repo)
  ├── Runs quilt-elf (the invisible elves)
  ├── Hosts quilt-pincher (the reflex engine)
  ├── Runs quilt-elf Cloudflare Worker
  └── Stores FederatedArtifactStore data
```

When the elves run invisibly in the background, this is the OS they run on. When the reflex engine responds in 50ms to a pinch, this is what makes that latency possible. When a remote device needs to survive for years without human intervention, this is what makes that survivable.

## ✦ Why you should care

If you've ever had a device fail in a remote location. If you've ever had a power outage corrupt your filesystem. If you've ever had to physically visit a device to fix a software issue. If you've ever wondered how to deploy 10,000 devices and have them all behave identically. If you've ever had a regulator ask you to prove your software supply chain is clean.

This repo is for you.

## ✦ License

Apache 2.0. See [LICENSE](./LICENSE).
