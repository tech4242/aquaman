/**
 * A throwaway certificate authority for tests of a TLS listener: an authority
 * and leaf certificates with the names a test asks for, made with the
 * `openssl` program in a directory the test owns. Nothing here is used
 * outside a test.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface Leaf {
  certPem: string;
  keyPem: string;
  /** Key and certificate in one file, the way Substrate writes a pod's credential bundle. */
  bundleFile: string;
}

export interface TestAuthority {
  caPem: string;
  caFile: string;
  /**
   * Issue a certificate. `uris` and `dns` become subject alternative names;
   * `expired` makes one whose validity ended an hour after it began, in 2020.
   */
  issue(name: string, names: { uris?: string[]; dns?: string[]; expired?: boolean }): Leaf;
}

const openssl = (cwd: string, args: string[]): void => {
  execFileSync('openssl', args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
};

/** Make an authority in `<dir>/<label>`. */
export function createTestAuthority(dir: string, label: string): TestAuthority {
  const home = path.join(dir, label);
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'index.txt'), '');
  fs.writeFileSync(path.join(home, 'serial'), '1000\n');
  fs.writeFileSync(path.join(home, 'ca.cnf'), [
    '[ca]', 'default_ca = test', '',
    '[test]', `dir = ${home}`, 'database = $dir/index.txt', 'serial = $dir/serial', 'new_certs_dir = $dir',
    'default_md = sha256', 'policy = any', 'unique_subject = no', 'copy_extensions = none', '',
    '[any]', 'commonName = supplied', '',
  ].join('\n'));
  openssl(home, ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
    '-keyout', 'ca.key', '-out', 'ca.crt', '-subj', `/CN=${label}`, '-days', '2',
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign']);
  const caFile = path.join(home, 'ca.crt');
  let count = 0;
  return {
    caPem: fs.readFileSync(caFile, 'utf-8'),
    caFile,
    issue(name, names) {
      const id = `${name}-${++count}`;
      // One line per name in its own section, so a name may hold a comma.
      const alt = [
        ...(names.uris ?? []).map((u, i) => `URI.${i + 1} = ${u}`),
        ...(names.dns ?? []).map((d, i) => `DNS.${i + 1} = ${d}`),
      ];
      fs.writeFileSync(path.join(home, `${id}.ext`), [
        'basicConstraints = CA:FALSE',
        'extendedKeyUsage = serverAuth, clientAuth',
        ...(alt.length > 0 ? ['subjectAltName = @alt', '', '[alt]', ...alt] : []),
        '',
      ].join('\n'));
      openssl(home, ['req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
        '-keyout', `${id}.key`, '-out', `${id}.csr`, '-subj', `/CN=${name}`]);
      openssl(home, ['ca', '-batch', '-config', 'ca.cnf', '-keyfile', 'ca.key', '-cert', 'ca.crt',
        '-in', `${id}.csr`, '-out', `${id}.crt`, '-extfile', `${id}.ext`, '-notext',
        ...(names.expired ? ['-startdate', '20200101000000Z', '-enddate', '20200101010000Z'] : ['-days', '1'])]);
      const certPem = fs.readFileSync(path.join(home, `${id}.crt`), 'utf-8');
      const keyPem = fs.readFileSync(path.join(home, `${id}.key`), 'utf-8');
      const bundleFile = path.join(home, `${id}.bundle.pem`);
      fs.writeFileSync(bundleFile, keyPem + certPem, { mode: 0o600 });
      return { certPem, keyPem, bundleFile };
    },
  };
}
