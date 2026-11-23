/**
 * `aquaman broker ask` and the ask-first parts of `broker allow`, `broker
 * list`, `request` and `get`.
 *
 * Setting a mark tightens what the daemon hands out, so a command does it
 * without asking anyone: through the running daemon, which then enforces it
 * at once, or straight into the vault when no daemon serves the broker.
 *
 * Removing a mark loosens it, so it is a person's decision, taken in the
 * dialog the daemon shows. A terminal is not taken as proof of a person,
 * because a program can give itself one. Only where the daemon reports that
 * it cannot show a dialog at all does the command ask at the terminal, and it
 * then changes the record with its own access to the vault.
 */

import type { Command } from 'commander';
import * as readline from 'node:readline';
import type { CredentialStore } from '../core/index.js';
import { parseAquamanRef, isReservedService, RESERVED_SERVICE_REASON } from '../broker-scope.js';
import { AskFirstMarks, AskFirstFullError, keepable, ASK_FIRST_PATH } from '../ask-first.js';
import { windowText, PROMPT_TIMEOUT_SECONDS, PROMPT_TIMEOUT_MIN_SECONDS, PROMPT_TIMEOUT_MAX_SECONDS, clampPromptTimeout } from '../credential-prompt.js';

type ProxyPost = (
  socketPath: string,
  urlPath: string,
  body: Record<string, unknown>,
  timeoutMs: number,
) => Promise<{ status: number; json: any } | { error: string; code: string }>;

export interface AskFirstCliDeps {
  proxyPost: ProxyPost;
  socketPath(): string;
  /** The vault, for when no daemon serves the broker and for the terminal fallback. */
  openStore(): Promise<CredentialStore>;
  /** `<service>/<key>` of every declared reference. */
  declared(): string[];
  /** Whether a reference is bound through the proxy and declared nowhere else, so its value is never handed out. */
  routedOnly(ref: string): boolean;
  /** `broker.askFirstWindowSeconds`, clamped. */
  windowSeconds(): number;
}

function fail(error: string, fix?: string): never {
  console.error(error);
  if (fix) console.error(`Fix: ${fix}`);
  process.exit(1);
}

function askYes(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    let answer = '';
    // Resolved when the input closes, so input that ends without an answer
    // (Ctrl-D) is a no and not a silent exit.
    rl.on('close', () => resolve(answer.trim().toLowerCase() === 'yes'));
    rl.question(question, (text) => {
      answer = text;
      rl.close();
    });
  });
}

/** Refs that parse and do not name aquaman's own records, or the reason one does not. */
function checkRefs(refs: string[]): { ok: true } | { ok: false; error: string; fix: string } {
  const invalid = refs.filter((r) => !parseAquamanRef(r));
  if (invalid.length > 0) {
    return { ok: false, error: `Invalid ref${invalid.length > 1 ? 's' : ''}: ${invalid.join(', ')}`, fix: 'Refs look like aquaman://<service>/<key>, e.g. aquaman://github/token' };
  }
  const reserved = refs.find((r) => isReservedService(parseAquamanRef(r)!.service));
  if (reserved) {
    return { ok: false, error: `Not marked: ${reserved}. "${parseAquamanRef(reserved)!.service}" ${RESERVED_SERVICE_REASON}.`, fix: 'Use a different service name' };
  }
  return { ok: true };
}

export type MarkResult =
  | { ok: true; where: 'daemon' | 'vault' }
  | { ok: false; error: string; fix?: string; code?: string };

/**
 * Mark references ask-first. Through the daemon when one serves the broker,
 * so the mark is enforced from the next request on; into the vault directly
 * when none does, where the next daemon reads it at its first request.
 */
export async function markAskFirst(refs: string[], deps: AskFirstCliDeps): Promise<MarkResult> {
  const checked = checkRefs(refs);
  if (!checked.ok) return checked;
  let where: 'daemon' | 'vault' = 'daemon';
  let marks: AskFirstMarks | undefined;
  for (const ref of refs) {
    const { service, key } = parseAquamanRef(ref)!;
    if (where === 'daemon') {
      const response = await deps.proxyPost(deps.socketPath(), ASK_FIRST_PATH, { service, key, ask: true }, 30_000);
      const noBroker = 'error' in response
        ? response.code === 'proxy_unreachable'
        // A proxy that hands nothing out (OpenClaw-hosted) keeps no marks.
        : response.status === 404 && response.json?.code === 'broker_disabled';
      if (!noBroker) {
        if ('error' in response) return { ok: false, error: `The daemon could not be asked: ${response.error}`, fix: 'aquaman doctor', code: response.code };
        if (response.status !== 200) return { ok: false, error: response.json?.error ?? `The daemon refused (${response.status})`, fix: response.json?.fix, code: response.json?.code };
        continue;
      }
      where = 'vault';
    }
    try {
      marks ??= new AskFirstMarks(await deps.openStore());
      await marks.mark(`${service}/${key}`);
    } catch (err) {
      if (err instanceof AskFirstFullError) return { ok: false, error: `${ref} was not marked: ${err.message}`, fix: err.fix, code: err.code };
      return { ok: false, error: `Could not write the ask-first mark to the vault: ${err instanceof Error ? err.message : String(err)}`, fix: 'aquaman doctor' };
    }
  }
  return { ok: true, where };
}

/** What `broker list` prints about marks: asked of the daemon, which is where they are enforced. */
export async function askFirstListing(deps: AskFirstCliDeps): Promise<{ marked: Set<string> | 'all'; windowSeconds: number } | undefined> {
  const response = await deps.proxyPost(deps.socketPath(), ASK_FIRST_PATH, { list: true }, 30_000);
  if ('error' in response || response.status !== 200) return undefined;
  const { marked, window_seconds: windowSeconds } = response.json ?? {};
  if (marked !== 'all' && !Array.isArray(marked)) return undefined;
  return { marked: marked === 'all' ? 'all' : new Set<string>(marked), windowSeconds: typeof windowSeconds === 'number' ? windowSeconds : deps.windowSeconds() };
}

export function registerAskFirstCommands(broker: Command, deps: AskFirstCliDeps): void {
  broker
    .command('ask')
    .description('Mark refs "ask first": the daemon shows a dialog before it hands the value out, and remembers a yes for a while. --off removes the mark, which you approve in a dialog')
    .argument('<refs...>', 'one or more aquaman://service/key refs (exactly one with --off)')
    .option('--off', 'Remove the mark. A person approves this in the daemon\'s dialog')
    .option('--timeout <seconds>', `With --off: how long the dialog waits for an answer (${PROMPT_TIMEOUT_MIN_SECONDS}-${PROMPT_TIMEOUT_MAX_SECONDS})`, String(PROMPT_TIMEOUT_SECONDS))
    .addHelpText('after', `
A marked ref is still declared. The difference is the first read: the daemon
shows a dialog, and a yes lets any program running as you read that value
until the window ends (broker.askFirstWindowSeconds in config.yaml, 8 hours by
default) or the daemon stops. aquaman cannot tell which program is asking.

The mark is kept in your vault, not in config.yaml or projects.yaml.

Exit codes with --off:
  0   the mark is removed (or there was none)
  2   a person said no
  3   nobody answered, or too many dialogs were shown; run it again
  1   the daemon is not running, refused, or the command was wrong

Examples:
  aquaman broker ask aquaman://github/token
  aquaman broker ask aquaman://github/token --off`)
    .action(async (refs: string[], opts: { off?: boolean; timeout: string }) => {
      const checked = checkRefs(refs);
      if (!checked.ok) fail(checked.error, checked.fix);

      if (!opts.off) {
        // A mark that gates nothing would read as protection that is not there.
        const routed = refs.filter((r) => deps.routedOnly(r));
        if (routed.length > 0) {
          fail(
            `Not marked: ${routed.join(', ')}. ${routed.length > 1 ? 'These are' : 'It is'} bound through the proxy only, so the value is never handed to a program and there is no read to ask about.`,
            'Nothing to do. If you later bind it without --via-proxy or allow it with `aquaman broker allow`, mark it then (aquaman broker allow <ref> --ask does both).',
          );
        }
        const result = await markAskFirst(refs, deps);
        if (!result.ok) fail(result.error, result.fix);
        for (const ref of refs) console.log(`Ask first: ${ref}`);
        console.log(`\nThe daemon now shows a dialog before it hands ${refs.length > 1 ? 'these values' : 'this value'} out. A yes lasts ${windowText(deps.windowSeconds())} or until the daemon stops, and covers every program running as you.`);
        if (result.where === 'vault') console.log('No daemon is serving the broker right now; the mark is in the vault and applies when `aquaman daemon` starts.');
        const undeclared = refs.filter((r) => { const p = parseAquamanRef(r)!; return !deps.declared().includes(`${p.service}/${p.key}`); });
        if (undeclared.length > 0) console.log(`Not declared yet, so not handed out at all: ${undeclared.join(', ')}  (aquaman broker allow <ref>)`);
        return;
      }

      if (refs.length !== 1) fail('--off takes one ref at a time: each removal is its own question to a person.', 'aquaman broker ask <ref> --off');
      if (!/^\d+$/.test(opts.timeout)) fail(`Invalid --timeout: ${opts.timeout}`, `Give a whole number of seconds between ${PROMPT_TIMEOUT_MIN_SECONDS} and ${PROMPT_TIMEOUT_MAX_SECONDS}`);
      const timeoutSeconds = clampPromptTimeout(Number(opts.timeout));
      const ref = refs[0];
      const { service, key } = parseAquamanRef(ref)!;
      const done = () => console.log(`${ref} is no longer marked ask-first. The daemon hands it out without a dialog whenever it is declared.`);

      console.error('Asking in a dialog on this machine. Look for it and allow it if you mean to remove the mark.');
      const response = await deps.proxyPost(
        deps.socketPath(),
        ASK_FIRST_PATH,
        { service, key, ask: false, project: process.cwd(), timeout_seconds: timeoutSeconds },
        (timeoutSeconds + 30) * 1000,
      );
      if ('error' in response) {
        if (response.code === 'proxy_unreachable') {
          fail('The daemon shows the dialog a mark is removed in, and it is not running.', 'aquaman daemon &   (then run this command again)');
        }
        fail(`The daemon could not be asked: ${response.error}`, 'aquaman doctor');
      }
      const { status, json } = response;
      if (status !== 200) fail(json.error ?? `The daemon refused the request (${status})`, json.fix);
      if (json.status === 'unmarked') {
        done();
        return;
      }
      if (json.status === 'ready') {
        console.log(`${ref} is not marked ask-first.`);
        return;
      }
      if (json.status === 'declined') {
        console.error(`Still marked: ${json.reason ?? 'declined'}`);
        process.exit(2);
      }
      if (json.code !== 'prompt_unavailable') {
        console.error(`Still marked: ${json.reason ?? 'nobody answered the dialog'}. Run the command again.`);
        process.exit(3);
      }

      // No dialog can be shown on this machine, so the question is put here.
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        fail(
          `No dialog can be shown on this machine (${json.reason}), and this command is not at a terminal, so nobody can be asked.`,
          `Run it yourself in a terminal: aquaman broker ask ${ref} --off`,
        );
      }
      console.error(`No dialog can be shown on this machine (${json.reason}).`);
      console.error(`This removes the "ask first" mark from ${ref}: aquaman then hands the value out without asking, to any program running as you, whenever it is declared.`);
      // A record that cannot be read marks everything, and is written again
      // with a list. The list is settled and shown before the question, and
      // is what gets written.
      let marks: AskFirstMarks;
      let keep: string[] | undefined;
      try {
        marks = new AskFirstMarks(await deps.openStore());
        if ((await marks.list()) === 'all') {
          keep = keepable(deps.declared(), `${service}/${key}`);
          console.error('The record of marks in the vault cannot be read, so every reference counts as marked.');
          console.error(keep.length === 0
            ? 'After a yes no reference is marked.'
            : `After a yes only ${keep.length === 1 ? 'this one stays' : `these ${keep.length} stay`} marked:\n${keep.map((n) => `  aquaman://${n}`).join('\n')}`);
        }
      } catch (err) {
        fail(`Could not read the ask-first record in the vault: ${err instanceof Error ? err.message : String(err)}`, err instanceof AskFirstFullError ? 'Revoke references that are no longer used (aquaman broker revoke <ref>), then run the command again' : 'aquaman doctor');
      }
      if (!(await askYes('Type yes to remove the mark: '))) {
        console.error('Still marked.');
        process.exit(2);
      }
      try {
        await marks.unmark(`${service}/${key}`, keep);
      } catch (err) {
        fail(`Could not change the ask-first record in the vault: ${err instanceof Error ? err.message : String(err)}`, 'aquaman doctor');
      }
      // The daemon answers from its copy of the record until it is told to read it again.
      await deps.proxyPost(deps.socketPath(), ASK_FIRST_PATH, { reload: true }, 30_000);
      done();
    });
}
