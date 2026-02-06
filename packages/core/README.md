# aquaman-core

Core credential storage, audit logging, and crypto utilities for [aquaman](https://github.com/tech4242/aquaman).

## What This Is

`aquaman-core` provides the foundational building blocks for credential isolation:

- **Credential backends** — Keychain (macOS), encrypted file (Linux/CI), 1Password, HashiCorp Vault
- **Audit logger** — Hash-chained (SHA-256) tamper-evident logging with WAL-based crash recovery
- **Crypto utilities** — Key derivation, AES-256-GCM encryption, hash chain verification

## Installation

```bash
npm install aquaman-core
```

## Credential Backends

| Backend | Platform | Use Case |
|---------|----------|----------|
| `keychain` | macOS | Local dev, personal machines |
| `encrypted-file` | Linux, WSL2, CI/CD | Servers without native keyring |
| `1password` | Any (via `op` CLI) | Team credential sharing |
| `vault` | Any (via HTTP API) | Enterprise secrets management |

## Usage

```typescript
import { createCredentialStore } from 'aquaman-core/credentials';
import { AuditLogger } from 'aquaman-core/audit';

// Create a credential store
const store = await createCredentialStore({ backend: 'keychain' });
await store.set('anthropic', 'api_key', 'sk-ant-...');
const key = await store.get('anthropic', 'api_key');

// Hash-chained audit logging
const logger = new AuditLogger({ logDir: '~/.aquaman/audit' });
await logger.log({ action: 'credential_access', service: 'anthropic' });
await logger.verify(); // Verify chain integrity
```

## Documentation

See the [main README](https://github.com/tech4242/aquaman#readme) for full documentation, architecture details, and configuration options.

## License

MIT
