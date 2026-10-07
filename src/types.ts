/** Public data contracts shared by the MCP tools, scheduler, and storage. */

export type Trigger =
  | { kind: 'once'; at: string }
  | { kind: 'cron'; cron: string };

export interface Action {
  session_id: string;
  text: string;
}

export interface Job {
  id: string;
  name?: string;
  trigger: Trigger;
  action: Action;
}

export interface Run {
  at: string;
  job_id: string;
  session_id: string;
  result: 'submitted' | 'failed' | 'skipped';
  reason?: string;
}

export interface JobSummary {
  job: Job;
  next_run_at: string | null;
  last_run: Run | null;
}

export interface SessionSummary {
  session_id: string;
  name: string | null;
  cwd: string | null;
  status: string | null;
  availability: 'available' | 'unavailable';
  reason?: string;
}
