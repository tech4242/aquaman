/**
 * Credential scanner - detects and redacts credentials in responses
 */

export interface ScanResult {
  found: boolean;
  matches: CredentialMatch[];
  redacted: string;
}

export interface CredentialMatch {
  type: string;
  value: string;
  startIndex: number;
  endIndex: number;
  redactedValue: string;
}

interface PatternConfig {
  type: string;
  pattern: RegExp;
  redactLength?: number;
}

const CREDENTIAL_PATTERNS: PatternConfig[] = [
  // API Keys
  {
    type: 'anthropic_api_key',
    pattern: /sk-ant-[a-zA-Z0-9_-]{40,}/g
  },
  {
    type: 'openai_api_key',
    pattern: /sk-[a-zA-Z0-9]{32,}/g
  },
  {
    type: 'github_token',
    pattern: /gh[pousr]_[a-zA-Z0-9]{36,}/g
  },
  {
    type: 'github_classic_token',
    pattern: /ghp_[a-zA-Z0-9]{36}/g
  },
  {
    type: 'slack_token',
    pattern: /xox[baprs]-[a-zA-Z0-9-]+/g
  },
  {
    type: 'slack_webhook',
    pattern: /https:\/\/hooks\.slack\.com\/services\/T[a-zA-Z0-9]+\/B[a-zA-Z0-9]+\/[a-zA-Z0-9]+/g
  },
  {
    type: 'discord_token',
    pattern: /[MN][A-Za-z\d]{23,}\.[\w-]{6}\.[\w-]{27}/g
  },
  {
    type: 'discord_webhook',
    pattern: /https:\/\/discord\.com\/api\/webhooks\/\d+\/[\w-]+/g
  },
  {
    type: 'aws_access_key',
    pattern: /AKIA[0-9A-Z]{16}/g
  },
  {
    type: 'aws_secret_key',
    pattern: /[a-zA-Z0-9/+=]{40}(?=\s|$|"|')/g,
    redactLength: 8
  },

  // Generic patterns
  {
    type: 'generic_api_key',
    pattern: /(?:api[_-]?key|apikey|api[_-]?secret|secret[_-]?key)[\s]*[=:]\s*["']?([a-zA-Z0-9_-]{20,})["']?/gi
  },
  {
    type: 'bearer_token',
    pattern: /Bearer\s+[a-zA-Z0-9._-]{20,}/gi
  },
  {
    type: 'basic_auth',
    pattern: /Basic\s+[a-zA-Z0-9+/=]{20,}/gi
  },

  // Private keys
  {
    type: 'private_key',
    pattern: /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(?:RSA\s+)?PRIVATE\s+KEY-----/g
  },
  {
    type: 'private_key_openssh',
    pattern: /-----BEGIN\s+OPENSSH\s+PRIVATE\s+KEY-----[\s\S]*?-----END\s+OPENSSH\s+PRIVATE\s+KEY-----/g
  },

  // Database connection strings
  {
    type: 'postgres_url',
    pattern: /postgres(?:ql)?:\/\/[^:]+:[^@]+@[^/]+\/[^\s"']+/gi
  },
  {
    type: 'mysql_url',
    pattern: /mysql:\/\/[^:]+:[^@]+@[^/]+\/[^\s"']+/gi
  },
  {
    type: 'mongodb_url',
    pattern: /mongodb(?:\+srv)?:\/\/[^:]+:[^@]+@[^\s"']+/gi
  },

  // JWT tokens
  {
    type: 'jwt',
    pattern: /eyJ[a-zA-Z0-9_-]*\.eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*/g
  }
];

export class CredentialScanner {
  private patterns: PatternConfig[];
  private customPatterns: PatternConfig[] = [];

  constructor(additionalPatterns?: PatternConfig[]) {
    this.patterns = [...CREDENTIAL_PATTERNS];
    if (additionalPatterns) {
      this.customPatterns = additionalPatterns;
    }
  }

  scan(text: string): ScanResult {
    const matches: CredentialMatch[] = [];
    const allPatterns = [...this.patterns, ...this.customPatterns];

    for (const config of allPatterns) {
      // Reset regex state
      config.pattern.lastIndex = 0;

      let match: RegExpExecArray | null;
      while ((match = config.pattern.exec(text)) !== null) {
        const value = match[1] || match[0]; // Use capture group if exists
        const startIndex = match.index;
        const endIndex = startIndex + match[0].length;

        // Avoid duplicates
        const isDuplicate = matches.some(m =>
          m.startIndex === startIndex && m.endIndex === endIndex
        );

        if (!isDuplicate) {
          matches.push({
            type: config.type,
            value: match[0],
            startIndex,
            endIndex,
            redactedValue: this.redact(value, config.redactLength)
          });
        }
      }
    }

    // Sort by position
    matches.sort((a, b) => a.startIndex - b.startIndex);

    return {
      found: matches.length > 0,
      matches,
      redacted: this.redactText(text, matches)
    };
  }

  private redact(value: string, keepLength?: number): string {
    if (keepLength && value.length > keepLength * 2) {
      const prefix = value.slice(0, keepLength);
      const suffix = value.slice(-keepLength);
      return `${prefix}${'*'.repeat(8)}${suffix}`;
    }

    if (value.length <= 8) {
      return '*'.repeat(value.length);
    }

    const showLength = Math.min(4, Math.floor(value.length / 4));
    return value.slice(0, showLength) + '*'.repeat(8) + value.slice(-showLength);
  }

  private redactText(text: string, matches: CredentialMatch[]): string {
    if (matches.length === 0) return text;

    let result = '';
    let lastIndex = 0;

    for (const match of matches) {
      result += text.slice(lastIndex, match.startIndex);
      result += match.redactedValue;
      lastIndex = match.endIndex;
    }

    result += text.slice(lastIndex);
    return result;
  }

  addPattern(type: string, pattern: RegExp, redactLength?: number): void {
    this.customPatterns.push({ type, pattern, redactLength });
  }

  removePattern(type: string): boolean {
    const index = this.customPatterns.findIndex(p => p.type === type);
    if (index >= 0) {
      this.customPatterns.splice(index, 1);
      return true;
    }
    return false;
  }

  getPatternTypes(): string[] {
    return [
      ...this.patterns.map(p => p.type),
      ...this.customPatterns.map(p => p.type)
    ];
  }

  /**
   * Recursively redact credentials in an object
   * Returns a deep copy with all string values scanned and redacted
   */
  redactObject<T>(obj: T): T {
    if (obj === null || obj === undefined) {
      return obj;
    }

    if (typeof obj === 'string') {
      return this.scan(obj).redacted as T;
    }

    if (Array.isArray(obj)) {
      return obj.map(item => this.redactObject(item)) as T;
    }

    if (typeof obj === 'object') {
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(obj)) {
        result[key] = this.redactObject(value);
      }
      return result as T;
    }

    return obj;
  }
}

export function createCredentialScanner(additionalPatterns?: PatternConfig[]): CredentialScanner {
  return new CredentialScanner(additionalPatterns);
}

export function quickScan(text: string): boolean {
  const scanner = new CredentialScanner();
  return scanner.scan(text).found;
}

export function redactCredentials(text: string): string {
  const scanner = new CredentialScanner();
  return scanner.scan(text).redacted;
}
