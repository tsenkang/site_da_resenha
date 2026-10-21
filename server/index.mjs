import http from 'node:http';
import { leaderboard } from './leaderboard.mjs';
import { send } from './leaderboard/rest.mjs';
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url?.split('?')[0] === '/api/health') return send(res, 200, { status: 'ok' });
  leaderboard.middleware(req, res, () => { res.writeHead(404); res.end(); });
});
server.requestTimeout = 15000;
server.headersTimeout = 10000;
server.listen(Number(process.env.PORT || 3000), '0.0.0.0');
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => leaderboard.close().finally(() => process.exit(0))));
