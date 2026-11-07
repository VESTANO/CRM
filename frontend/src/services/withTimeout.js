export function withTimeout(promise, timeoutMs, message, host = window) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = host.setTimeout(() => reject(new Error(message)), timeoutMs); }),
  ]).finally(() => host.clearTimeout(timer));
}
