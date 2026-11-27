export type JobStatus = "running" | "done" | "error" | "canceled" | "attention";

export interface CrewErrorPayload {
  code: string;
  message: string;
  fix: string;
}

export class CrewCliError extends Error {
  readonly code: string;
  readonly fix: string;
  readonly exitCode: number;

  constructor(code: string, message: string, fix: string, exitCode = 1) {
    super(message);
    this.name = "CrewCliError";
    this.code = code;
    this.fix = fix;
    this.exitCode = exitCode;
  }

  toPayload(): CrewErrorPayload {
    return {
      code: this.code,
      message: this.message,
      fix: this.fix,
    };
  }
}

export interface RoleConfig {
  worker: string;
  model?: string;
  machine?: string;
  /** The worker's agent definition to use (agy `--agent`); defaults to the role's name. */
  agent?: string;
}

export interface CrewConfig {
  roles: Record<string, RoleConfig>;
  machines?: Record<string, string>;
  paths?: Record<string, string>;
}

export interface UsageMetrics {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  total_cost_usd?: number;
  [key: string]: number | string | boolean | undefined;
}

export interface UsageRecord {
  jobId: string;
  role: string;
  worker: string;
  model: string | null;
  machine: string;
  timestamp: string;
  usage: UsageMetrics;
}

export interface JobRecord {
  id: string;
  role: string;
  worker: string;
  /** The agent definition the worker runs; absent on older records (then the role name). */
  agent?: string;
  model: string | null;
  machine: string;
  machineTarget: string;
  remotePath: string | null;
  branch: string | null;
  worktree: string;
  briefFile: string;
  pid: number | null;
  start: string;
  end: string | null;
  exit: number | null;
  status: JobStatus;
  conversationId: string | null;
  continuedFrom: string | null;
  logFile: string;
  stdoutFile: string;
  resultText: string | null;
  error: CrewErrorPayload | null;
}
