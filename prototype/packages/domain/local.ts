export function assertLocal(url = 'http://127.0.0.1:8545', chainId = 31337): void {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(parsed.hostname)
      || parsed.username || parsed.password || chainId !== 31337) {
    throw new Error('LOCAL_CHAIN_ONLY');
  }
}
