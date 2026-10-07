# Dispatch

Dispatch schedules messages to running Claude Code sessions on the same machine. Agents use MCP tools to find sessions, manage jobs, send a job immediately, and inspect runs. An HTTP route also accepts an immediate message for a specified session. A background service owns the schedule, so jobs remain scheduled after the session that created them closes.

## How it works

1. `list_sessions` reads `claude agents --json` and the local session records written by Claude Code. Those records map a conversation ID to an inbox socket path. An agent selects a conversation by `session_id` and creates a job through the MCP server. Session names and working directories are display information, not routing keys. Dispatch installs no Claude Code hook.
2. One persistent Dispatch MCP server accepts tool calls over HTTP on the local machine and evaluates jobs. A one-time trigger uses a future ISO 8601 date and time with a time-zone offset. A recurring trigger uses a standard five-field cron expression in the host time zone. Invalid trigger values are rejected. If a previous delivery for the same job is still in progress when another firing comes due, Dispatch records a skipped run. When Dispatch restarts, it does not send messages missed while it was down: recurring jobs resume at their next future time, and each overdue one-time job gets a failed run with the reason and is removed.
3. When a job fires, Dispatch reads the current session record for the target ID. It checks that the recorded PID still refers to the same process and that the inbox socket is reachable, then submits the message. If the target session is offline, Dispatch records a failed run with the reason and does not queue the message for later. A recurring job tries again at its next scheduled time. A one-time job is removed after its run is resolved, whether the schedule or `run_job` started it. After `/clear`, Claude Code uses a new conversation ID; jobs for the old ID do not move to it.

### Finding the inbox socket

Claude Code writes session records under its config directory, normally `~/.claude/sessions/`. Dispatch reads their `sessionId`, `pid`, `procStart`, and `messagingSocketPath` fields. A record can remain after its process exits, and a socket file can remain after it stops accepting connections. Dispatch checks process identity and socket reachability each time it lists or sends to a session; it does not store a second registration. A session without a live, matching record cannot receive a Dispatch message.

Claude Code does not document its session-file format, so an update may change it. `claude agents --json` alone does not include the socket path.

### Socket submission

Dispatch opens the socket found in the record for the target session and writes one JSON object followed by a newline:

~~~jsonl
{"msgV":1,"msg_id":"<new UUID>","type":"user","message":{"role":"user","content":"<job text>"},"priority":"next","session_id":"<target session ID>"}
~~~

Dispatch substitutes a new UUID, the job text, and the target session ID, using JSON encoding for each value. It sends the complete line, then closes the writing side of the connection. The socket selects the recipient; `session_id` guards against a socket that now belongs to a different conversation. Dispatch does not set `from`, so the message has no reply address. [Claude Code says the auth line is optional on Linux and macOS](https://code.claude.com/docs/en/cross-session-messaging#the-sessions-inbox-socket).

On October 5, 2026, idle disposable sessions running Claude Code 2.1.289 and 2.1.290 on Linux replied to this exact frame, sent without an auth line to the socket found in each session file. Claude Code does not document the full message format either. After upgrading Claude Code, repeat this test: start a disposable session, find its socket from its session file, send it a message, and check its reply.

Claude Code may deliver, hold for approval, or refuse an inbound message. A successful socket write means `submitted`, not `delivered`; Dispatch has no delivery receipt. The receiving session labels the message as coming from another session. Its agent treats the message as an agent request, not an instruction or approval from its user.

## Architecture

Dispatch is one Node.js/TypeScript process. It serves MCP tools over Streamable HTTP on `127.0.0.1`, owns the schedule and stored data, and sends messages to Claude Code sockets. Claude Code connects directly to the server, which stays running after Claude Code sessions close. [Claude Code supports HTTP MCP servers](https://code.claude.com/docs/en/mcp#option-1-add-a-remote-http-server).

The HTTP endpoints and tool input validation use the [official MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) (`@modelcontextprotocol/server`, `@modelcontextprotocol/express`, and `@modelcontextprotocol/node`), `express`, and `zod`. [Croner](https://github.com/Hexagon/croner) (`croner`) parses the five-field cron expressions and calculates future run times. Dispatch loads saved jobs when it starts. Node.js built-ins handle JSON files, the `claude agents --json` command, and Unix socket messages. The server requires no token by default. When `DISPATCH_TOKEN` is set, MCP and message requests must carry the matching Bearer token; an empty value is rejected. Claude Code connects through a user-scoped MCP registration. A service manager keeps Dispatch running after Claude Code sessions close.

## Data storage

Dispatch stores jobs as JSON in a config directory and the run log in a separate data directory accessible only to the operating-system user. It reads live session information from Claude Code when needed; it stores no socket paths.

### Jobs

~~~ts
interface Job {
  id: string;             // assigned by Dispatch
  name?: string;          // optional display label
  trigger: Trigger;
  action: Action;
}

type Trigger =
  | { kind: "once"; at: string }     // ISO 8601 date and time with offset
  | { kind: "cron"; cron: string };  // five-field cron expression

interface Action {
  session_id: string;     // target conversation ID
  text: string;
}
~~~

Only Claude Code sessions are supported. A job targets one conversation ID. The next run time is calculated from its trigger; it is not part of the stored job.

### Run log

~~~ts
interface Run {
  at: string;            // ISO 8601 date and time
  job_id: string;
  session_id: string;
  result: "submitted" | "failed" | "skipped";
  reason?: string;       // why a run failed or was skipped
}
~~~

Dispatch records a run for every scheduled firing while it is running, every manual request, and every overdue one-time job it finds on restart. `submitted` means the socket write completed. `failed` means Dispatch could not submit the message, including when the target session is offline or Dispatch was down at the scheduled time. `skipped` means a previous delivery for the same job was still in progress, so Dispatch did not try. `reason` explains a failure or skip; the message being sent remains on the job as `action.text`. The log supplies the last result for each job.

## MCP tools

The MCP server exposes these tools. Inputs and results below describe the tool payloads; invalid input and unknown job IDs return tool errors. Times in tool results use ISO 8601.

### `list_sessions`

~~~ts
list_sessions(): SessionSummary[];

interface SessionSummary {
  session_id: string;     // sessionId from claude agents --json
  name: string | null;
  cwd: string | null;
  status: string | null;  // status or state from the Claude listing
  availability: "available" | "unavailable";
  reason?: string;       // why submission is unavailable
}
~~~

Lists running local Claude Code sessions. `availability` is `available` when Dispatch finds a matching live session record and can reach its inbox socket; this does not promise delivery. When it is `unavailable`, `reason` explains why and is required. For an available session, `reason` is omitted. If `claude` is unavailable or its listing fails, the tool returns an error instead of a stale listing.

### `create_job`

~~~ts
create_job(input: {
  name?: string;
  trigger: Trigger;
  action: Action;
}): Job;
~~~

Creates a job and assigns its ID. The trigger must be valid; `session_id` and `text` must be nonempty. The target need not be running when the job is created.

### `update_job`

~~~ts
update_job(input: {
  id: string;
  name?: string | null;
  trigger?: Trigger;
  action?: Action;
}): Job;
~~~

Changes the supplied fields of an existing job. At least one change is required. `name: null` clears the label; omitted fields stay as they are.

### `delete_job`

~~~ts
delete_job(input: { id: string }): { deleted: true };
~~~

Removes an existing job. Its past runs remain in the log.

### `list_jobs`

~~~ts
list_jobs(): JobSummary[];

interface JobSummary {
  job: Job;
  next_run_at: string | null;
  last_run: Run | null;
}
~~~

Lists stored jobs, their next run times, and their most recent run. `next_run_at` is null when no future run is scheduled.

### `run_job`

~~~ts
run_job(input: { id: string }): Run;
~~~

Runs an existing job immediately and returns the recorded outcome. For a one-time job, this uses its only firing; the job does not run again at its originally scheduled time.

### `list_runs`

~~~ts
list_runs(input?: { job_id?: string; limit?: number }): Run[];
~~~

Returns recent runs, newest first. `job_id` filters to one job. `limit` must be a positive integer and defaults to 100.

## HTTP messages

~~~http
POST /sessions/{session_id}/messages
Content-Type: application/json

{"text":"Hello Claude"}
~~~

This route submits the text to the named Claude Code session immediately. `session_id` and `text` must be nonempty. A successful socket write returns HTTP 202 with `{"status":"submitted"}`. This does not confirm that Claude Code delivered or acted on the message. A validation error returns 400; an unavailable session or failed socket write returns 503 with an `error` string. When `DISPATCH_TOKEN` is set, the route requires the same Bearer token as MCP and returns 401 without it. Immediate messages do not create jobs or run-log entries.

When `DISPATCH_BROWSER_ORIGIN` is set to one exact HTTP or HTTPS origin, Dispatch returns CORS headers for that origin and answers its preflight requests for this route. The Bearer token requirement still applies when `DISPATCH_TOKEN` is set.

## Out of scope

- Sub-minute schedules.
- Jobs on other machines.
- Native Windows named-pipe delivery.
