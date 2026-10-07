// Claude Code headersHelper expects one JSON object on stdout.
const token = process.env.DISPATCH_TOKEN;
if (!token) throw new Error('DISPATCH_TOKEN is required');
process.stdout.write(JSON.stringify({ Authorization: `Bearer ${token}` }));
