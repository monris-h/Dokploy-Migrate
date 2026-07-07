import { NodeSSH, type Config as SSHConfig, type SSHExecCommandOptions } from "node-ssh";
import { promises as fs } from "node:fs";
import path from "node:path";

export type SshTarget = {
  host: string;
  port?: number;
  username: string;
  privateKeyPath?: string;
  privateKey?: string;
  password?: string;
  passphrase?: string;
};

export type ExecResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

export class Ssh {
  private conn: NodeSSH;

  constructor(private readonly target: SshTarget) {
    this.conn = new NodeSSH();
  }

  async connect(): Promise<void> {
    const cfg: SSHConfig = {
      host: this.target.host,
      port: this.target.port ?? 22,
      username: this.target.username,
      tryKeyboard: true,
      onKeyboardInteractive: async (
        _name: string,
        _instructions: string,
        _lang: string,
        prompts: string[],
        finish: (answers: string[]) => void
      ) => {
        if (this.target.password) {
          finish(prompts.map(() => this.target.password!));
          return;
        }
        finish([]);
      },
    };

    if (this.target.privateKeyPath) {
      cfg.privateKey = await fs.readFile(this.target.privateKeyPath, "utf8");
    } else if (this.target.privateKey) {
      cfg.privateKey = this.target.privateKey;
    } else if (this.target.password) {
      cfg.password = this.target.password;
    } else {
      throw new Error(
        "Falta credencial SSH: proporciona privateKeyPath, privateKey o password."
      );
    }

    if (this.target.passphrase) {
      cfg.passphrase = this.target.passphrase;
    }

    await this.conn.connect(cfg);
  }

  async disconnect(): Promise<void> {
    await this.conn.dispose();
  }

  async exec(
    command: string,
    opts?: SSHExecCommandOptions & { cwd?: string; input?: Buffer | string }
  ): Promise<ExecResult> {
    const fullCmd = opts?.cwd ? `cd ${shellQuote(opts.cwd)} && ${command}` : command;
    const r = await this.conn.execCommand(fullCmd, opts);
    return {
      code: r.code ?? null,
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
    };
  }

  async uploadString(content: string, remotePath: string): Promise<void> {
    const Buffer = await import("node:buffer").then((m) => m.Buffer);
    await this.conn.putBuffer(Buffer.from(content, "utf8"), remotePath);
  }

  async uploadFile(localPath: string, remotePath: string): Promise<void> {
    await this.conn.putFile(localPath, remotePath);
  }

  async downloadFile(remotePath: string, localPath: string): Promise<void> {
    await fs.mkdir(path.dirname(localPath), { recursive: true });
    await this.conn.getFile(localPath, remotePath);
  }

  async fileExists(remotePath: string): Promise<boolean> {
    const r = await this.exec(`test -e ${shellQuote(remotePath)} && echo OK || echo MISS`);
    return r.stdout.trim() === "OK";
  }

  async fileSize(remotePath: string): Promise<number> {
    const r = await this.exec(
      `stat -c '%s' ${shellQuote(remotePath)} 2>/dev/null || echo 0`
    );
    const n = parseInt(r.stdout.trim(), 10);
    return Number.isFinite(n) ? n : -1;
  }
}

export function shellQuote(s: string): string {
  if (/^[a-zA-Z0-9_\-\.\/=]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}
