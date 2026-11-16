/**
 * Configuration failures are fatal and must be actionable. A process that
 * starts with a missing secret and discovers it at 3am under load is strictly
 * worse than one that refuses to start.
 */
export class ConfigurationError extends Error {
  override readonly name = 'ConfigurationError';

  constructor(
    message: string,
    readonly issues: ReadonlyArray<{ key: string; problem: string; hint?: string }> = [],
  ) {
    super(message);
  }

  /** Multi-line operator-facing rendering, used by the startup guard. */
  format(): string {
    if (this.issues.length === 0) return this.message;
    const lines = this.issues.map(
      (i) => `  • ${i.key}: ${i.problem}${i.hint ? `\n      → ${i.hint}` : ''}`,
    );
    return `${this.message}\n\n${lines.join('\n')}\n`;
  }
}
