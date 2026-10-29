/** SimpleWebAuthn 包装后的取消错误与原生 DOMException 都应安静处理。 */
export function isPasskeyCancellation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { name?: string; code?: string; cause?: { name?: string } };
  return (
    e.name === 'AbortError' ||
    e.name === 'NotAllowedError' ||
    e.code === 'ERROR_CEREMONY_ABORTED' ||
    e.cause?.name === 'AbortError' ||
    e.cause?.name === 'NotAllowedError'
  );
}

/** 用户已选中凭据、服务端拒绝后抛出的错误；条件式登录据此提示并重新等待选择。 */
export const afterSelection = (error: unknown) => Object.assign(error as object, { afterSelection: true });

/** 登录页拥有此请求的生命周期；注入依赖便于脱离浏览器验证异步竞争。 */
export function beginPasskeyAutofill(deps: {
  supports: () => Promise<boolean>;
  login: (signal: AbortSignal) => Promise<void>;
  cancel: () => void;
  onError?: (error: unknown) => void;
}): () => void {
  const controller = new AbortController();
  let started = false;
  void (async () => {
    try {
      if (!(await deps.supports()) || controller.signal.aborted) return;
      while (!controller.signal.aborted) {
        try {
          started = true;
          await deps.login(controller.signal);
          return;
        } catch (error) {
          if (controller.signal.aborted || isPasskeyCancellation(error)) return;
          if (!error || typeof error !== 'object') return;
          // 用户可能在五分钟后才选中建议；取新挑战，再次等待选择。
          if ('code' in error && error.code === 'PASSKEY_CHALLENGE_EXPIRED') continue;
          // 选中的凭据被拒（未绑定、校验失败、限速）：提示原因，再挂上建议让用户换一条；选中前的失败（如网络）仍安静停止
          if (!('afterSelection' in error)) return;
          deps.onError?.(error);
        }
      }
    } catch {
      // 条件式界面不可用或网络失败时，密码和显式 Passkey 按钮仍可使用。
    }
  })();
  return () => {
    if (controller.signal.aborted) return;
    controller.abort();
    if (started) deps.cancel();
  };
}
