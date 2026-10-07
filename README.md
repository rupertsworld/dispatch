# Dispatch

Dispatch is an MCP server that schedules work for a running coding agent by sending it a message at the right time. Ask your agent to review your tasks every morning or check on a long-running build in 20 minutes. Dispatch currently works with Claude Code; other agents and job types are planned.

## Get Started

With Node.js 20 or newer, start the published package in one terminal:

```sh
npx @rupertsworld/dispatch
```

In another terminal, register it with Claude Code:

```sh
claude mcp add --transport http dispatch http://127.0.0.1:17865/mcp --scope user
```

Then try this in Claude Code (illustrative output):

```text
$ claude
> Use Dispatch to send this session "Say hello world" in two minutes.

● Scheduled.

  ...two minutes later...

● Another Claude session sent a message:
  Say hello world.

● Hello world.
```

Keep both the Dispatch terminal and the receiving session open until the message arrives. If several sessions are running, Claude Code may ask which one to target. It may also add its own sender and safety text.

## Jobs

Dispatch currently supports one job type:

| Job type | Status | What it does |
| --- | --- | --- |
| Message an existing session | Available | Sends stored text to a running session for the agent to act on. |

More job types can be added. A message job stores its text and target session, and uses one of these schedules:

| Schedule | Example | Behavior |
| --- | --- | --- |
| Once | Tomorrow at 2:00 p.m. | Runs at that time, then ends. |
| Cron | `0 9 * * 1-5` | Runs at 9:00 every weekday until deleted. |

Use `create_job` to schedule work, `run_job` to run it now, and `list_jobs` or `list_runs` to inspect it. Messages only reach sessions that are still running. [The specification](docs/spec.md) covers the other tools and run rules.

## Send a message now

An HTML artifact can send text to a known session with `POST /sessions/{session_id}/messages`. The request body is `{"text":"Hello Claude"}`. Dispatch returns `{"status":"submitted"}` when it writes to the Claude Code inbox; Claude Code may still decline the message. This sends immediately and creates no scheduled job.

Dispatch listens on the local machine. For a browser artifact, set `DISPATCH_BROWSER_ORIGIN` to its origin. A browser on another device also needs an address that reaches Dispatch; a proxy is one way to provide it. If you enable `DISPATCH_TOKEN`, keep the token in a server-side component, not in artifact code. See the [HTTP message interface](docs/spec.md#http-messages) for responses and errors.

## Supported agents

| Agent | Status | Delivery |
| --- | --- | --- |
| Claude Code | Supported | Sends the message to a local running session. |
| Other agents | Planned | No integration yet. |

Claude Code shows the message as coming from another session and may add its own safety text.

## Security

The server has no token by default and listens on `127.0.0.1:17865`. Any local process that can reach it can read scheduled messages, change jobs, and send messages. Use this default only where local processes are trusted; do not expose the port to other machines without access control.

Set `DISPATCH_TOKEN` in the server environment to require a matching `Authorization: Bearer` header from Claude Code and HTTP message callers. A token protects the endpoints, but processes running as the same operating-system user can still read stored jobs.
