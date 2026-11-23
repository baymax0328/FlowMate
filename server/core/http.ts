// FlowMate · HTTP 统一契约：响应信封、异常映射、Zod 校验管道、幂等（PRD §19）
import {
  ArgumentsHost, CallHandler, Catch, ConflictException, DynamicModule, ExceptionFilter, ExecutionContext,
  Injectable, NestInterceptor, PipeTransform, CanActivate, SetMetadata, Inject,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { Observable, map } from 'rxjs';
import { ZodError, type ZodType } from 'zod';
import { AppError } from './errors';
import { getDb, nowIso, uuid } from './db';
import crypto from 'node:crypto';

export const REQUEST_ID = Symbol('request_id');

export function requestId(req: Request & { id?: string }): string {
  if (!req.id) req.id = uuid();
  return req.id;
}

@Injectable()
export class EnvelopeInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const res = ctx.switchToHttp().getResponse<Response>();
    res.setHeader('X-Request-Id', requestId(ctx.switchToHttp().getRequest<Request>()));
    return next.handle().pipe(map((data) => (data && typeof data === 'object' && 'data' in data && 'request_id' in data
      ? data
      : { data, request_id: requestId(ctx.switchToHttp().getRequest<Request>()) })));
  }
}

@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  catch(err: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    const rid = requestId(req);
    let status = 500;
    let code = 'INTERNAL';
    let message = '服务内部错误';
    let fieldErrors: Record<string, string> | undefined;
    let extra: Record<string, unknown> = {};

    if (err instanceof AppError) {
      const body = err.getResponse() as Record<string, unknown>;
      status = err.getStatus();
      code = err.code;
      message = err.message;
      fieldErrors = err.field_errors;
      extra = { ...body };
      delete extra.code; delete extra.message; delete extra.field_errors;
    } else if (err instanceof ZodError) {
      status = 400; code = 'VALIDATION'; message = '输入不合法';
      fieldErrors = {};
      for (const i of err.issues) fieldErrors[String(i.path.join('.')) || '_'] = i.message;
    } else if (err instanceof ConflictException) {
      status = 409; code = 'CONFLICT'; message = err.message;
    } else if (err && typeof err === 'object' && 'status' in err && typeof (err as { status: unknown }).status === 'number') {
      const e = err as { status: number; message?: unknown; response?: Record<string, unknown> };
      status = e.status;
      message = typeof e.message === 'string' ? e.message : '请求失败';
      code = status === 413 ? 'FILE_TOO_LARGE' : status === 403 ? 'FORBIDDEN' : status === 401 ? 'AUTH_REQUIRED' : 'VALIDATION';
      if (e.response?.message) message = Array.isArray(e.response.message) ? e.response.message.join('；') : String(e.response.message);
    }
    if (status >= 500 && code === 'INTERNAL') console.error(`[http] ${rid}`, err);
    const error = { code, message, field_errors: fieldErrors ?? null, ...extra };
    delete (error as Record<string, unknown>).data;
    res.status(status).json({ error, request_id: rid });
  }
}

@Injectable()
export class ZodPipe implements PipeTransform {
  constructor(private readonly schema: ZodType) {}
  transform(value: unknown) {
    return this.schema.parse(value);
  }
}
export const z = (schema: ZodType) => new ZodPipe(schema);

export const IDEMPOTENT = Symbol('idempotent');
export const RequireIdempotency = () => SetMetadata('idempotent', true);

/**
 * 幂等写入（§16 / §19）：同 key 同 payload 复用首次响应；异 payload 返回 409。
 * 只对写请求生效，key 缺失时放行（读接口不需要）。
 */
@Injectable()
export class IdempotencyGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request & { actor?: { userId: string; orgId: string }; idem?: string }>();
    const key = req.header('Idempotency-Key');
    if (!key) return true;
    if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) return true;
    const actor = req.actor;
    if (!actor) return true;
    const sig = crypto.createHash('sha256').update(JSON.stringify(req.body ?? {})).digest('hex');
    const d = getDb();
    const row = d.get<{ payload_hash: string; response: string | null }>(
      'SELECT payload_hash, response FROM idempotency_keys WHERE org_id=? AND user_id=? AND key=?', actor.orgId, actor.userId, key);
    if (row) {
      if (row.payload_hash !== sig) throw AppError.forbidden('同一 Idempotency-Key 不能用于不同请求体');
      if (row.response) {
        const res = ctx.switchToHttp().getResponse<Response>();
        const parsed = JSON.parse(row.response);
        res.status(parsed.status).json(parsed.body);
        return false;
      }
      req.idem = 'replay-pending';
      return true;
    }
    d.run('INSERT INTO idempotency_keys(user_id,org_id,key,route,payload_hash,response,created_at) VALUES(?,?,?,?,?,NULL,?)',
      actor.userId, actor.orgId, key, `${req.method} ${req.path}`, sig, nowIso());
    return true;
  }
}

/** 响应写回幂等缓存 */
@Injectable()
export class IdempotencySaveInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = ctx.switchToHttp();
    const req = http.getRequest<Request & { actor?: { userId: string; orgId: string } }>();
    const key = req.header('Idempotency-Key');
    const actor = req.actor;
    if (!key || !actor) return next.handle();
    const res = http.getResponse<Response>();
    return next.handle().pipe(map((body) => {
      try {
        getDb().run('UPDATE idempotency_keys SET response=? WHERE org_id=? AND user_id=? AND key=?',
          JSON.stringify({ status: res.statusCode, body: body as object }), actor.orgId, actor.userId, key);
      } catch (e) {
        console.warn('[idempotency] 缓存写入失败', (e as Error).message);
      }
      return body;
    }));
  }
}
