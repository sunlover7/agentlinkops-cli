// Only the OS advisory lock coordinates recovery. Path age is never ownership.
import { ConfigError } from './config.js';
let binding;
export async function nativeLock(platform = process.platform) {
  if (!['darwin', 'linux'].includes(platform)) throw new ConfigError('Sync lock recovery is unsupported on this platform; no writer started.');
  if (!binding) {
    try {
      const { default: koffi } = await import('koffi');
      const lib = koffi.load(platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6');
      const flock = lib.func('int flock(int fd, int operation)');
      binding = { acquire(fd) {
        if (flock(fd, 2 | 4) === 0) return true;
        const code = koffi.errno();
        if (code === koffi.os.errno.EWOULDBLOCK || code === koffi.os.errno.EAGAIN) return false;
        throw new ConfigError('Kernel sync lock failed; no writer started.');
      } };
    } catch (error) {
      throw new ConfigError('Native sync lock is unavailable; reinstall the CLI with its platform dependencies. No writer started.');
    }
  }
  return binding;
}
