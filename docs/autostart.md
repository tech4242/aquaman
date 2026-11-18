# Start the aquaman daemon at login

`aquaman daemon` runs until you log out or reboot, and `aquaman init --agent` starts it the same way. A host that is always on (OpenClaw, Hermes, Docker Sandboxes) loses its credentials when the daemon is gone. `aquaman service install` adds a login item so the daemon starts at every login and is restarted if it crashes.

```bash
aquaman service install      # asks one y/N question, then installs and starts it
aquaman service status       # is it installed, is it loaded, whose daemon is on the socket
aquaman service uninstall    # stops it and removes the unit file
```

Each command takes `--json`. `aquaman service install --dry-run` prints the unit file and the commands it would run, and changes nothing.

## What is installed

| | macOS | Linux |
|---|---|---|
| Kind | launchd agent, label `sh.aquaman.daemon` | systemd user unit `aquaman.service` |
| File | `~/Library/LaunchAgents/sh.aquaman.daemon.plist` | `~/.config/systemd/user/aquaman.service` |
| Runs | `<node> <aquaman cli> daemon`, both as absolute paths | the same |
| Starts | at login (`RunAtLoad`) | with your user manager (`WantedBy=default.target`) |
| Restarts | unless the daemon exits cleanly (`KeepAlive`, `SuccessfulExit` false) | when it fails (`Restart=on-failure`) |
| Loaded with | `/bin/launchctl bootstrap gui/<uid> <plist>` | `systemctl --user daemon-reload`, then `systemctl --user enable --now aquaman.service` |
| Log | `~/.aquaman/daemon.log`, readable by you only | `journalctl --user -u aquaman.service` |

The unit's environment holds two things: a `PATH` (the directory of the Node binary, then `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`, so vault CLIs such as `op`, `bw` and `keeper` are found) and `AQUAMAN_CONFIG_DIR` if it was set when you ran `install`. Nothing else is written into it, and no secret ever is.

The unit names the Node binary and the aquaman CLI by absolute path. After you move or upgrade either (a new Node version under a version manager, for example), run `aquaman service install` again. `aquaman service status` reports when the unit on disk differs from the one `install` would write now.

If a daemon is already running when you install, it is stopped so the service's daemon can take the socket. Only a daemon that aquaman's own pid file names, and that reports the same pid over the socket, is stopped. A proxy started by the OpenClaw plugin is not: `install` stops with an error and you stop that proxy yourself.

`aquaman stop` still works: the daemon exits cleanly, so it is not restarted until the next login. To start it again before that, log out and in, or run `aquaman daemon`.

## A person decides

A login item starts at every login, and `aquaman service install` may be run by an AI agent. So the command only installs after a person said yes:

- **At a terminal** it asks one y/N question.
- **Without a terminal** it asks the running daemon to show an approval dialog on your screen. The dialog says that aquaman will start at every login and keep running, and how to remove it. Nothing is typed into it. It shares the limits of the credential dialog: one dialog at a time, at most six in ten minutes, and no repeat for ten minutes after a no. The outcome is written to the audit log.

No flag and no environment variable skips the question.

| Status | Exit code | Meaning |
|---|---|---|
| `installed` | 0 | The unit is installed and loaded |
| `already_installed` | 0 | The same unit was already installed and loaded. Nobody was asked |
| `dry_run` | 0 | `--dry-run`: nothing was changed |
| `declined` | 2 | A person said no. The reply carries no `fix` |
| `pending` | 3 | Nobody could be asked: the daemon is not running, it has no desktop session, or the dialog was not answered. `fix` is the step for a person: run `aquaman service install` in a terminal |
| `error` | 4 | The proxy on the socket does not take the question (an OpenClaw-hosted proxy, or the broker switched off) |
| `error` | 1 | Refused: see the limits below, or a system tool failed. `error` and `fix` say which |

`aquaman init --agent <agent> --service` asks for the same thing, through the dialog, after setup has succeeded, and reports the answer as `service` in its JSON. Without `--service`, `init` installs nothing and lists `aquaman service install` as a step for a person. See [Using aquaman from an AI agent](agent-setup.md).

This is not a boundary against software running as you: such software can write a launch agent or a user unit itself. What it does is keep aquaman's own commands from adding a login item nobody saw.

## Limits

- **The `encrypted-file` backend is refused.** Its daemon needs `AQUAMAN_ENCRYPTION_PASSWORD` in the environment, and a login item can only have that by storing the password on disk, which aquaman does not do. Use a backend that needs no password in the environment (the macOS Keychain, the Linux keyring, or `systemd-creds`), or keep starting the daemon by hand with `aquaman daemon`.
- **Settings that exist only in your shell do not reach the service.** The daemon started at login does not inherit your shell's environment. A `VAULT_TOKEN`, `BW_SESSION`, `OP_SERVICE_ACCOUNT_TOKEN` or `AQUAMAN_BACKEND` that you export before `aquaman daemon` is not there. `install` and `status` list the names of such variables that are set (`env_not_passed`), never their values. Put what can go in `~/.aquaman/config.yaml` there; a backend that needs a secret in the environment has to be started by hand.
- **Headless Linux needs lingering.** systemd starts your user units at boot only if your user lingers; otherwise they start when you log in and stop when you log out. aquaman does not change that itself. It reports the command as a step for a person: `loginctl enable-linger <user>`.
- **Linux without a login session.** `systemctl --user` needs your user manager. Over SSH without one, `install` fails and says so; enable lingering first.
- **No dialog on a headless machine.** Without a desktop session the daemon cannot show the approval dialog, so the command answers `pending`. Run it in a terminal.
- **Only macOS and Linux.** Other platforms have no unit; start the daemon by hand.

## Remove it

```bash
aquaman service uninstall
```

That stops the service (`launchctl bootout gui/<uid>/sh.aquaman.daemon`, or `systemctl --user disable --now aquaman.service`) and deletes the unit file. The daemon it ran stops with it. Removing needs nobody's approval.

To check by hand that nothing is left: the file in the table above is gone, and `launchctl print gui/$(id -u)/sh.aquaman.daemon` or `systemctl --user status aquaman.service` no longer finds the service.

## If you are an agent

- Do not install the service unprompted. Propose it when the user runs an always-on host or asks why the daemon was gone after a reboot.
- Run `aquaman service install --json` (or pass `--service` to `aquaman init --agent`). You have no terminal, so the user sees a dialog. `declined` means stop and ask; `pending` means give the user the `fix`.
- Do not write the unit file yourself, and do not look for a way around a `declined`.
