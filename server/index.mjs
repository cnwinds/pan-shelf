import fs from 'node:fs';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { migrateLegacy } from './db.mjs';
import { getSettings } from './settings.mjs';
import { recoverOnBoot } from './jobs.mjs';
import { startScheduler } from './scheduler.mjs';
import { WEB_DIST, SERVER_INFO } from './paths.mjs';
import { initCatalog } from './catalog.mjs';
import routes from './api.mjs';
import './tasks/crawl.mjs';
import './tasks/transfer.mjs';
import './tasks/normalize.mjs';
import './tasks/du.mjs';
import './tasks/prune.mjs';
import './tasks/dedupe.mjs';
import './tasks/remove.mjs';

const migrated = migrateLegacy();
if (migrated) console.log(`已导入旧版数据：帖子 ${migrated.posts}，链接 ${migrated.links}，用量记录 ${migrated.du}`);
initCatalog();
const interrupted = recoverOnBoot();
if (interrupted) console.log(`上次有 ${interrupted} 个任务未完成，已标记为「已中断」，可在任务页重新运行`);

const app = Fastify({ logger: false });
app.addContentTypeParser('*', (req, payload, done) => done(null, {}));
app.setErrorHandler((err, req, reply) => {
  reply.code(err.statusCode || 500).send({ error: err.message || String(err) });
});
await app.register(routes);

if (fs.existsSync(WEB_DIST)) {
  await app.register(fastifyStatic, { root: WEB_DIST });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.code(404).send({ error: '接口不存在' });
    reply.sendFile('index.html');
  });
}

const port = Number(process.env.PS5WATCH_PORT) || getSettings().server.port;
try {
  await app.listen({ host: process.env.PS5WATCH_HOST || '127.0.0.1', port });
} catch (e) {
  if (e.code === 'EADDRINUSE') { console.error(`端口 ${port} 已被占用，可能服务已经在运行了：http://127.0.0.1:${port}`); process.exit(1); }
  throw e;
}
fs.writeFileSync(SERVER_INFO, JSON.stringify({ pid: process.pid, port, started_at: new Date().toISOString() }));
const cleanup = () => { try { const s = JSON.parse(fs.readFileSync(SERVER_INFO, 'utf8')); if (s.pid === process.pid) fs.unlinkSync(SERVER_INFO); } catch {} process.exit(0); };
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

startScheduler();
console.log(`盘架 PanShelf 已启动：http://127.0.0.1:${port}`);
