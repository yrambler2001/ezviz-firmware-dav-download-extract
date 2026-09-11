# EZVIZ firmware DAV — download & extract

Fetch Hikvision / EZVIZ `digicap.dav` firmware images from the EZVIZ cloud and
extract them all the way down to the SquashFS root filesystem.

Two things live here:

- **`ezviz-firmware.js`** — logs into the EZVIZ cloud API and downloads whatever
  firmware the account is entitled to.
- **`unpack-dav.sh`** — strips the `.dav` container and unpacks the SquashFS root
  filesystem, transparently using Docker when the host can't run the bundled
  Linux x86-64 tool.

This repo also documents one specific build end to end — see
[The device](#the-device) and [What's inside](#whats-inside).

---

## The device

| | |
|---|---|
| **Model** | `DS-2CD2443G2-IW-W` |
| Family | EZVIZ / Hikvision indoor cube ("G2") |
| SoC | Fullhan **FH865x** |
| Sensor | SmartSens **SC4336** (4 MP) |
| Wi-Fi | Realtek **RTL8188FU** (USB) |

Identified from the unpacked root filesystem — see [What's inside](#whats-inside)
for the exact evidence.

## The firmware

| | |
|---|---|
| **Version** | `V5.3.8 build 251219` |
| Previous | `V5.3.8 build 241123` |
| File | `digicap.dav` |
| Size | 13,347,484 bytes |
| **MD5** | `018e3c5e2452f13a156f8005137e0665` |
| Container | `HKWS` (magic `0x484B5753`) |
| Language | `1` (EN) |

### Download link

```
https://devupgrade-ali.ys7.com/018e3c5e2452f13a156f8005137e0665/digicap.dav
```

The path segment **is** the file's MD5 — the CDN is content-addressed. The same
build will always resolve to this URL, and it needs no authentication:

```sh
curl -L -o digicap.dav \
  https://devupgrade-ali.ys7.com/018e3c5e2452f13a156f8005137e0665/digicap.dav

md5 -q digicap.dav     # macOS   -> 018e3c5e2452f13a156f8005137e0665
md5sum digicap.dav     # Linux   -> 018e3c5e2452f13a156f8005137e0665
```

The binary is **not vendored in this repository** — see [Legal](#legal).

---

## Quick start

### 1. Get the firmware

Either use the direct link above, or let the script discover it through the
account that owns the camera:

```sh
node ezviz-firmware.js <email> <password> --list     # show devices, download nothing
node ezviz-firmware.js <email> <password>            # download to ./firmware
```

Options: `--out <dir>`, `--list`, `--region <host>`, `--help`.

#### Only pending upgrades are downloaded

The script checks every device first and writes a file **only** when the server
reports an upgrade that is not already on disk:

| Server says | Result |
|---|---|
| update available | downloaded, md5 verified |
| already up to date | reported as `current`, nothing written |
| up to date, model unconfirmed | reported as `unresolved` |
| image already on disk | reported as `exists`, not re-fetched |
| device not owned | reported as `not-owned` (code `20002`) |
| no upgrade record | reported as `no-record` |

So it never pulls a full image just because it is listed, and a run is safe to
repeat — it fetches only what is genuinely pending. Use `--list` to get the same
picture without downloading anything.

Because filenames are `<serial>_<version>.dav`, a device that is up to date
simply produces no new file, and one that has already been fetched is left
alone. Delete the file if you want to force a re-download.

> **Credential hygiene.** Passing the password as an argument exposes it to
> `ps`. Prefer a wrapper that reads it interactively, and rotate it afterwards.
> Never commit credentials — this repo's `.gitignore` covers the obvious
> footguns, but that is not a substitute for not writing them down.

The API only serves firmware for devices the account **owns**. Cameras merely
*shared* to an account are refused with code `20002`
(*"current user does not have this device"*) — that is the server enforcing
ownership, not a bug.

### 2. Unpack it

```sh
./unpack-dav.sh firmware/digicap_V5.3.8_build_251219.dav
```

Options: `-t <type>` (default `r0`), `-o <dir>` (default `<davdir>/unpacked`),
`-p <hikpack>`, `-n` (never use Docker), `-h`.

The script:

1. Runs `hikpack -t <type> -x <dav> -o <outdir>` to strip the container.
2. Locates the SquashFS image **by magic** (`hsqs`), not by filename.
3. Runs `unsquashfs` into `<outdir>/rootfs`.

If no SquashFS is present it stops cleanly after step 1.

#### Platform handling

`hikpack` is a Linux **x86-64** ELF and will not run natively on macOS.

| Host | Executor |
|---|---|
| macOS (any CPU) | Docker, `--platform linux/amd64` |
| Linux x86-64 | native |
| Linux arm64 / other | Docker |

On x86-64 Linux the script also *probes* the binary and falls back to Docker if
it fails to exec (wrong libc, missing loader) — `uname` alone is not trusted.

Two images are used, both verified working:

- `debian:bullseye-slim` — runs `hikpack`
- `debian:bookworm-slim` — provides `squashfs-tools`. **Not** bullseye:
  its security repo is expired and `apt-get update` fails there.

Override with `HIK_IMAGE`, `SQFS_IMAGE`, `DOCKER_PLATFORM`.

### 3. Pick the right `-t` type

`hikpack` needs the platform type. `r0`/`r1` cover the HKWS container used here.
If you get `Invalid magic`, try the others:

| Type | Platform |
|---|---|
| `r0`, `r1` | cameras (HKWS) — use these first |
| `r6`, `g0` | cameras (HK20/HK30) |
| `k41`, `k51` | NVRs |

`hikpack` handles the `HKWS` container used by this device natively — it
decrypts the outer layer itself, so **pass it the original `.dav`**. Feeding it
a file you have already XOR-decrypted will fail with `Invalid magic.`

---

## What's inside

```
digicap.dav                  13,347,484 B   HKWS container
└── unpacked/
    ├── dav_header                  196 B   container header
    ├── mImage                3,483,968 B   u-boot ARM kernel — 2024-04-17 (recovery)
    ├── app.img               7,516,248 B   SquashFS 4.0 / xz  -> rootfs/
    ├── uImage                2,346,816 B   u-boot ARM kernel — 2025-12-08 (main)
    └── dav_extra_tail              256 B   unattributed trailer
```

Size accounting is exact:
`196 + 3483968 + 7516248 + 2346816 + 256 = 13347484`

### `rootfs/` — 55 files

SquashFS 4.0, xz, 56 inodes, built 2025-12-19. The device identity is here:

| Evidence | Conclusion |
|---|---|
| `libf7_isp.so`, `libys_vqe_fh865x_*.so`, `c2det_230824_865x.nbg`, `YS_VQE_PARAM_0x3038.json` | Fullhan **FH865x** SoC |
| `sc4336_mipi_{day,night}_{hdr,lnr,nigcol}.hex`, `libsc4336_mipi.so` | SmartSens **SC4336** sensor |
| `8188fu.ko`, `TXPWR_LMT.txt`, `PHY_REG_PG.txt` | Realtek **RTL8188FU** Wi-Fi |

Also present: `da_info`, `ezdsp`, `execSystemCmd`, `hostapd`, `wpa_supplicant`,
`udhcpc`, `udhcpd`, `initrun.sh`, `wifi_cmd.sh`, and font/logo assets.

## Encrypted regions

Not everything is readable. These are **not** plaintext, and the keys are not
public:

| File | Status |
|---|---|
| `uImage`, `mImage` | payload **encrypted** — entropy 8.0, incompressible, no ARM entry stub or compression magic. u-boot headers themselves are valid and CRC-check. |
| `ezapp.xz_secure` | encrypted main application (~2 MB) |
| `filelist.enc.bin`, `enc_publickey.txt` | encrypted / key material |

`app.img` is the only fully readable payload, which is why `rootfs/` is
available while the kernels are not.

The last 256 bytes of the container are also unattributed — the same
`Extra tail at the end of dav, 256 bytes` warning appears on unrelated models,
suggesting a shared post-image block rather than anything model-specific.

---

## Repository layout

```
.
├── README.md
├── AUTH-NOTES.md                        EZVIZ cloud auth scheme notes
├── .gitignore
├── ezviz-firmware.js                    cloud login + firmware download
├── unpack-dav.sh                        container unpack + SquashFS extraction
├── hikpack                              third-party unpacker (x86-64 ELF, v2.5)
└── firmware/                            contents gitignored — see Legal
    ├── digicap_V5.3.8_build_251219.dav  13,347,484 B  md5 018e3c5e...
    ├── unpacked/                        regenerated by unpack-dav.sh
    └── rootfs/                          regenerated by unpack-dav.sh
```

| File | Purpose |
|---|---|
| `ezviz-firmware.js` | EZVIZ cloud login + firmware download (Node 18+, no dependencies) |
| `unpack-dav.sh` | `.dav` container unpack + SquashFS extraction |
| `hikpack` | Third-party Hikvision packer/unpacker, **v2.5** (2017), by *montecrypto* |
| `AUTH-NOTES.md` | The EZVIZ cloud auth scheme used by the JS |

## Requirements

- **Node 18+** for `ezviz-firmware.js` (uses global `fetch`)
- **Docker** on macOS or non-x86-64 Linux, for `unpack-dav.sh`
- `squashfs-tools` if running natively on Linux
- Network access on first run of the containerised squashfs step (it
  `apt-get install`s `squashfs-tools`)

## Caveats

- `hikpack` is **v2.5, dated 2017**. It predates `HK20`/`HK30` by years, so it
  parses that header format only partially. `HKWS` (used here) works.
- The EZVIZ cloud API used by `ezviz-firmware.js` is undocumented and can
  change without notice.
- Firmware URLs are content-addressed and unauthenticated. Treat them as
  public but not necessarily permanent.

## Legal

`hikpack` is a third-party binary included here for convenience, authored by
*montecrypto* — not by this repository.

Everything in this repo is published for interoperability research and
personal device maintenance. Only fetch firmware for devices you own.
