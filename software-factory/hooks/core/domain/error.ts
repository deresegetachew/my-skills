// What a port or a domain rule refuses with (decision 0003): the factory's {code, message, fix}. A command turns it
// into its usual refusal; nothing in the core prints or exits.
export class CoreError extends Error {
  readonly code: string;
  readonly fix: string;

  constructor(code: string, message: string, fix: string) {
    super(message);
    this.code = code;
    this.fix = fix;
  }

  toJSON(): { code: string; message: string; fix: string } {
    return { code: this.code, message: this.message, fix: this.fix };
  }
}
