import { createServer } from 'node:net';

export function instanceAddress(host: string, port: number): string {
  const local = host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host;
  return `http://${local.includes(':') ? `[${local}]` : local}:${port}`;
}

/** 开库与起 worker 之前先探测端口：同一台机器不允许同时跑两个实例。 */
export async function existingInstance(host: string, port: number): Promise<boolean> {
  const available = await new Promise<boolean>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') resolve(false);
      else reject(error);
    });
    probe.listen({ host, port, exclusive: true }, () => probe.close(error => error ? reject(error) : resolve(true)));
  });
  if (available) return false;

  const address = instanceAddress(host, port);
  try {
    const response = await fetch(`${address}/api/v1/health`, { signal: AbortSignal.timeout(1800) });
    const health = await response.json() as { ok?: boolean; mode?: string; components?: { database?: string; websocket_clients?: number }; db_stats?: unknown } | null;
    if (response.ok && health?.ok === true && health.mode === 'lite' && health.components?.database === 'ok'
      && typeof health.components?.websocket_clients === 'number' && health.db_stats) return true;
  } catch { /* 端口被占用时，只有对方确实是健康的 FlowMate 才算"已在运行"。 */ }
  throw new Error(`端口 ${port} 已被其他程序或未就绪的服务占用。请关闭占用程序，或设置 FLOWMATE_PORT 后重新启动。`);
}
