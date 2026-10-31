import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve } from 'node:path';

async function availablePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();

    server.once('error', reject);

    server.listen(0, '127.0.0.1', () => {
      const address = server.address();

      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('Could not allocate a test port'));
        return;
      }

      const port = address.port;

      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolvePort(port);
      });
    });
  });
}

export async function startApplicationProcess(
  databaseUrl: string,
  overrides: NodeJS.ProcessEnv = {},
) {
  const entrypoint = resolve('dist/main.js');

  await access(entrypoint);

  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  const child = spawn(process.execPath, [entrypoint], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL: databaseUrl,
      PORT: String(port),
      REFERENCE_WORKER_ENABLED: 'false',
      SQS_CONSUMER_ENABLED: 'false',
      OUTBOX_PUBLISHER_ENABLED: 'false',
      ...overrides,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  let stderr = '';
  let spawnError: Error | undefined;

  child.stderr?.setEncoding('utf8');

  child.stderr?.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-8_000);
  });

  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolveExit) => {
    child.once('error', (error) => {
      spawnError = error;
    });

    child.once('close', (code, signal) => {
      resolveExit({ code, signal });
    });
  });

  async function stop() {
    if (
      child.exitCode !== null ||
      child.signalCode !== null ||
      spawnError !== undefined
    ) {
      return exited;
    }

    child.kill('SIGTERM');

    let forced = false;

    const timer = setTimeout(() => {
      forced = true;
      child.kill('SIGKILL');
    }, 10_000);

    try {
      const result = await exited;

      if (forced) {
        throw new Error(
          `Application required SIGKILL during shutdown. ${stderr}`,
        );
      }

      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  async function crash() {
    if (
      child.exitCode === null &&
      child.signalCode === null &&
      spawnError === undefined
    ) {
      child.kill('SIGKILL');
    }

    return exited;
  }

  try {
    const deadline = Date.now() + 20_000;

    while (Date.now() < deadline) {
      if (spawnError) {
        throw spawnError;
      }

      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Application exited before becoming ready. ${stderr}`);
      }

      try {
        const response = await fetch(`${baseUrl}/health/live`, {
          signal: AbortSignal.timeout(500),
        });

        await response.text();

        if (response.ok) {
          return {
            baseUrl,
            stop,
            crash,
          };
        }
      } catch {
        // Aguarda o servidor começar a aceitar conexões.
      }

      await new Promise<void>((resolveWait) => {
        setTimeout(resolveWait, 100);
      });
    }

    throw new Error(`Application startup timed out. ${stderr}`);
  } catch (error: unknown) {
    await stop();
    throw error;
  }
}
