# Use your own vault as the NVIDIA OpenShell credential driver

NVIDIA OpenShell keeps provider credentials out of its sandboxes: the sandbox sees a placeholder and the supervisor injects the real value on the way out. aquaman can be the gateway's external credential driver, so OpenShell takes each key from the vault you already use, by reference, and never keeps its own copy.

```bash
npm install -g aquaman-proxy @grpc/grpc-js @grpc/proto-loader
aquaman setup                                        # 1. pick your vault
aquaman broker allow aquaman://anthropic/api_key     # 2. allow the key to be handed to OpenShell
aquaman openshell setup                              # 3. enable the driver, prints the gateway config
aquaman daemon &                                     # 4. start or restart the daemon
```

These commands are for a person in their own terminal: `aquaman setup` asks questions, `aquaman credentials add` asks for the value (hidden), and `aquaman daemon` stays running. An agent setting up a coding project uses [`aquaman init --agent`](agent-setup.md) instead.

Add the printed `[openshell.credential_drivers.aquaman]` table to your gateway config and restart the gateway. Then create providers with a reference instead of a value:

```bash
openshell provider create --name claude --type anthropic \
  --credential ANTHROPIC_API_KEY=aquaman://anthropic/api_key
```

## Good to know

- A reference must be declared (`aquaman broker allow`) and exist in the vault. `aquaman broker revoke` stops it resolving.
- A plain value (`--credential KEY=sk-...`) is stored in your vault under the `openshell` service.
- OpenShell resolves when a sandbox starts, not per request, so expect one audit entry per sandbox start.
- Since OpenShell 0.1.8 a credential without placement metadata is only injected into `Authorization`. For `x-api-key` or another header, set the placement in the provider profile.
- `aquaman openshell doctor --gateway-config <file>` checks the packages, the socket, your declared references and the gateway config.

More: [main README](../README.md)
