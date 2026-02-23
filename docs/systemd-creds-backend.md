# systemd-creds Backend

The `systemd-creds` backend encrypts credentials using Linux's
[systemd-creds](https://www.freedesktop.org/software/systemd/man/latest/systemd-creds.html)
utility, which leverages the system's TPM2 chip (when available) for
hardware-backed encryption.

## Requirements

- **Linux** with **systemd ≥ 256** (for `--user` support)
- **No root/sudo required** — uses `systemd-creds --user`
- TPM2 chip recommended (virtual or physical) but not strictly required

## Setup

```bash
# Check if systemd-creds --user is available
systemd-creds --user --version

# Setup aquaman with systemd-creds backend
aquaman setup --backend systemd-creds

# Add credentials
aquaman credentials add anthropic api_key
aquaman credentials add openai api_key
```

## How It Works

Each credential is stored as a separate `.cred` file in `~/.aquaman/creds.d/`:

```
~/.aquaman/creds.d/
  anthropic--api_key.cred    # encrypted with systemd-creds --user
  openai--api_key.cred
  github--api_key.cred
  _index.cred                # encrypted index of all credentials
```

### Encryption

Credentials are encrypted with `systemd-creds --user encrypt`, which:

1. Uses the per-user credential key (managed by systemd)
2. Binds to TPM2 when available — secrets can't be decrypted on another machine
3. Requires no master password — the key is tied to the user session

### In-Memory Caching

Decrypted values are cached in-memory for the lifetime of the aquaman proxy
process. This means each credential is decrypted at most once per proxy start,
minimizing overhead.

## Security Properties

| Property | Status |
|----------|--------|
| Encryption at rest | ✅ AES-256 via systemd-creds |
| TPM2 binding | ✅ When TPM2 available |
| No master password | ✅ Key managed by systemd |
| Per-user isolation | ✅ Uses `--user` flag |
| No root required | ✅ Runs as regular user |
| Survives reboot | ✅ Credentials persist in ~/.aquaman/creds.d/ |
| Portable to other machines | ❌ By design (TPM-bound) |

## Comparison with encrypted-file

| | `encrypted-file` | `systemd-creds` |
|---|---|---|
| Master password | Required (12+ chars) | None |
| Hardware binding | No | Yes (TPM2) |
| Portability | Can move between machines | Bound to machine |
| Root required | No | No |
| Platform | Any | Linux (systemd ≥ 256) |

## Troubleshooting

### "systemd-creds: command not found"

Install systemd (usually included in all modern Linux distributions).

### "Failed to encrypt/decrypt"

Check that `systemd-creds --user encrypt` works:

```bash
echo "test" | systemd-creds --user encrypt --name=test - -
```

If this fails, your systemd version may not support `--user` (requires ≥ 256).

### Adding a vTPM to a VM

If running in a VM without TPM2, add a virtual TPM:

**QEMU/KVM (libvirt):**
```bash
sudo dnf install swtpm swtpm-tools  # or apt install
# Add to VM XML inside <devices>:
# <tpm model='tpm-crb'>
#   <backend type='emulator' version='2.0'/>
# </tpm>
```

**Proxmox:** Enable TPM in VM hardware settings.

**VirtualBox 7.0+:** Settings → System → Enable TPM 2.0.
