// FlowMate · 统一错误契约（PRD §19 错误码）
// 成功 {data, request_id}；错误 {error:{code,message,field_errors}, request_id}
import { HttpException } from '@nestjs/common';

export class AppError extends HttpException {
  constructor(public code: string, message: string, public httpStatus = 400, public field_errors?: Record<string, string>, public extra?: Record<string, unknown>) {
    super({ code, message, field_errors: field_errors ?? null, ...(extra ?? {}) }, httpStatus);
  }
  static validation(msg = '输入不合法', field_errors?: Record<string, string>) {
    return new AppError('VALIDATION', msg, 400, field_errors);
  }
  static auth() {
    return new AppError('AUTH_REQUIRED', '请先登录', 401);
  }
  static forbidden(msg = '没有权限执行该操作') {
    return new AppError('FORBIDDEN', msg, 403);
  }
  /** 无权对象不返回标题、摘要或计数（§15 / C20） */
  static notFound(msg = '对象不存在或不可见') {
    return new AppError('NOT_FOUND', msg, 404);
  }
  static versionConflict(current: unknown) {
    return new AppError('VERSION_CONFLICT', '基准版本已变化，请重新加载后重试', 409, undefined, { current_version: current });
  }
  static invalidTransition(msg: string) {
    return new AppError('INVALID_TRANSITION', msg, 409);
  }
  static proposalStale(msg = '提案基准或内容已变化，需重新生成差异后再确认') {
    return new AppError('PROPOSAL_STALE', msg, 409);
  }
  /** 正在执行或被提案引用的文件默认阻止删除（§06） */
  static busy(msg: string, extra?: Record<string, unknown>) {
    return new AppError('RESOURCE_BUSY', msg, 423, undefined, extra);
  }
  static tooLarge(msg: string, limit: number) {
    return new AppError('FILE_TOO_LARGE', msg, 413, undefined, { max_bytes: limit });
  }
  static unsupported(msg: string) {
    return new AppError('UNSUPPORTED_FILE_TYPE', msg, 415);
  }
  static modelInvalid(msg = '模型返回内容不符合结构要求，可重试一次') {
    return new AppError('MODEL_OUTPUT_INVALID', msg, 422);
  }
  static extractFailed(msg = '正文抽取失败', extra?: Record<string, unknown>) {
    return new AppError('EXTRACT_FAILED', msg, 422, undefined, extra);
  }
  static providerUnavailable(msg = '模型服务不可用，未生成任何结果') {
    return new AppError('PROVIDER_UNAVAILABLE', msg, 503);
  }
  static rate(msg = '操作过于频繁，请稍后重试') {
    return new AppError('RATE_LIMIT', msg, 429);
  }
  /** 工具白名单之外的能力不存在（§8.3） */
  static toolDenied(msg: string) {
    return new AppError('FORBIDDEN', msg, 403);
  }
}

export const ERR = {
  VALIDATION: 'VALIDATION',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  VERSION_CONFLICT: 'VERSION_CONFLICT',
  INVALID_TRANSITION: 'INVALID_TRANSITION',
  PROPOSAL_STALE: 'PROPOSAL_STALE',
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  UNSUPPORTED_FILE_TYPE: 'UNSUPPORTED_FILE_TYPE',
  EXTRACT_FAILED: 'EXTRACT_FAILED',
  MODEL_OUTPUT_INVALID: 'MODEL_OUTPUT_INVALID',
  RESOURCE_BUSY: 'RESOURCE_BUSY',
  RATE_LIMIT: 'RATE_LIMIT',
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
} as const;
